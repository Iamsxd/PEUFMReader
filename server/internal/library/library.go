package library

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

var (
	ErrUnsupportedFormat = errors.New("unsupported ebook format")
	ErrUploadTooLarge    = errors.New("upload exceeds configured size limit")
	ErrUnsafePath        = errors.New("unsafe library path")
)

type Manager struct {
	libraryRoot string
	stagingRoot string
	cacheRoot   string
	maxBytes    int64
}

type StoredFile struct {
	OriginalFilename string
	RelativePath     string
	AbsolutePath     string
	SHA256           []byte
	SHA256Hex        string
	Format           string
	MIMEType         string
	SizeBytes        int64
	Created          bool
}

func NewManager(libraryRoot, stagingRoot, cacheRoot string, maxBytes int64) (*Manager, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("maxBytes must be positive")
	}
	for _, dir := range []string{libraryRoot, stagingRoot, cacheRoot} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("create storage directory %s: %w", dir, err)
		}
	}
	return &Manager{libraryRoot: libraryRoot, stagingRoot: stagingRoot, cacheRoot: cacheRoot, maxBytes: maxBytes}, nil
}

func (m *Manager) Ingest(originalFilename string, src io.Reader) (StoredFile, error) {
	originalFilename = filepath.Base(strings.TrimSpace(originalFilename))
	if originalFilename == "." || originalFilename == "" {
		originalFilename = "book"
	}

	temp, err := os.CreateTemp(m.stagingRoot, "upload-*.part")
	if err != nil {
		return StoredFile{}, fmt.Errorf("create staging file: %w", err)
	}
	tempPath := temp.Name()
	keepTemp := false
	defer func() {
		_ = temp.Close()
		if !keepTemp {
			_ = os.Remove(tempPath)
		}
	}()

	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temp, hasher), io.LimitReader(src, m.maxBytes+1))
	if copyErr != nil {
		return StoredFile{}, fmt.Errorf("copy upload: %w", copyErr)
	}
	if written > m.maxBytes {
		return StoredFile{}, ErrUploadTooLarge
	}
	if err := temp.Sync(); err != nil {
		return StoredFile{}, fmt.Errorf("sync staging file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return StoredFile{}, fmt.Errorf("close staging file: %w", err)
	}

	format, mimeType, err := detectFormat(tempPath)
	if err != nil {
		return StoredFile{}, err
	}
	hashBytes := hasher.Sum(nil)
	hashHex := hex.EncodeToString(hashBytes)
	relativePath := filepath.Join(hashHex[:2], hashHex+"."+format)
	absolutePath, err := SecureResolve(m.libraryRoot, relativePath)
	if err != nil {
		return StoredFile{}, err
	}
	if err := os.MkdirAll(filepath.Dir(absolutePath), 0o750); err != nil {
		return StoredFile{}, fmt.Errorf("create managed library directory: %w", err)
	}

	created := false
	if _, err := os.Stat(absolutePath); errors.Is(err, os.ErrNotExist) {
		if err := moveIntoLibrary(tempPath, absolutePath); err != nil {
			return StoredFile{}, fmt.Errorf("move file into managed library: %w", err)
		}
		if err := os.Chmod(absolutePath, 0o640); err != nil {
			return StoredFile{}, fmt.Errorf("set managed file permissions: %w", err)
		}
		keepTemp = true
		created = true
	} else if err != nil {
		return StoredFile{}, fmt.Errorf("inspect managed file: %w", err)
	}

	return StoredFile{
		OriginalFilename: originalFilename,
		RelativePath:     filepath.ToSlash(relativePath),
		AbsolutePath:     absolutePath,
		SHA256:           hashBytes,
		SHA256Hex:        hashHex,
		Format:           format,
		MIMEType:         mimeType,
		SizeBytes:        written,
		Created:          created,
	}, nil
}

// moveIntoLibrary prefers an atomic rename, but staging and library are often
// separate bind mounts on NAS installations. In that case rename returns a
// cross-device error, so copy to a temporary file on the destination volume
// and atomically rename that file into place.
func moveIntoLibrary(sourcePath, destinationPath string) error {
	if err := os.Rename(sourcePath, destinationPath); err == nil {
		return nil
	}

	source, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open staged file for cross-volume copy: %w", err)
	}
	defer source.Close()

	destinationDir := filepath.Dir(destinationPath)
	temp, err := os.CreateTemp(destinationDir, ".managed-*.part")
	if err != nil {
		return fmt.Errorf("create destination temporary file: %w", err)
	}
	tempPath := temp.Name()
	keepTemp := false
	defer func() {
		_ = temp.Close()
		if !keepTemp {
			_ = os.Remove(tempPath)
		}
	}()

	if _, err := io.Copy(temp, source); err != nil {
		return fmt.Errorf("copy staged file across volumes: %w", err)
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("sync destination temporary file: %w", err)
	}
	if err := temp.Chmod(0o640); err != nil {
		return fmt.Errorf("set destination temporary file permissions: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close destination temporary file: %w", err)
	}
	if err := os.Rename(tempPath, destinationPath); err != nil {
		return fmt.Errorf("commit destination file: %w", err)
	}
	keepTemp = true
	return nil
}

func (m *Manager) Resolve(relativePath string) (string, error) {
	return SecureResolve(m.libraryRoot, filepath.FromSlash(relativePath))
}

func (m *Manager) StoreCover(sha256Hex, extension string, content []byte) (string, error) {
	if len(content) == 0 || len(content) > 12<<20 {
		return "", fmt.Errorf("cover content size is invalid")
	}
	if decoded, err := hex.DecodeString(sha256Hex); err != nil || len(decoded) != sha256.Size {
		return "", fmt.Errorf("cover hash is invalid")
	}
	extension = strings.ToLower(strings.TrimPrefix(extension, "."))
	if extension != "jpg" && extension != "jpeg" && extension != "png" && extension != "webp" && extension != "gif" {
		return "", fmt.Errorf("cover extension is unsupported")
	}
	relativePath := filepath.Join("covers", sha256Hex[:2], sha256Hex+"."+extension)
	absolutePath, err := SecureResolve(m.cacheRoot, relativePath)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(absolutePath), 0o750); err != nil {
		return "", fmt.Errorf("create cover cache directory: %w", err)
	}
	if _, err := os.Stat(absolutePath); err == nil {
		return filepath.ToSlash(relativePath), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("inspect cached cover: %w", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(absolutePath), ".cover-*.part")
	if err != nil {
		return "", fmt.Errorf("create cover temporary file: %w", err)
	}
	tempPath := temp.Name()
	committed := false
	defer func() {
		_ = temp.Close()
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()
	if _, err := temp.Write(content); err != nil {
		return "", fmt.Errorf("write cover cache: %w", err)
	}
	if err := temp.Sync(); err != nil {
		return "", fmt.Errorf("sync cover cache: %w", err)
	}
	if err := temp.Chmod(0o640); err != nil {
		return "", fmt.Errorf("set cover permissions: %w", err)
	}
	if err := temp.Close(); err != nil {
		return "", fmt.Errorf("close cover cache: %w", err)
	}
	if err := os.Rename(tempPath, absolutePath); err != nil {
		return "", fmt.Errorf("commit cover cache: %w", err)
	}
	committed = true
	return filepath.ToSlash(relativePath), nil
}

func (m *Manager) ResolveCover(relativePath string) (string, error) {
	return SecureResolve(m.cacheRoot, filepath.FromSlash(relativePath))
}

func (m *Manager) RemoveIfCreated(stored StoredFile) {
	if stored.Created {
		_ = os.Remove(stored.AbsolutePath)
	}
}

func SecureResolve(root, relativePath string) (string, error) {
	if relativePath == "" || filepath.IsAbs(relativePath) || !filepath.IsLocal(relativePath) {
		return "", ErrUnsafePath
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve library root: %w", err)
	}
	joinedAbs, err := filepath.Abs(filepath.Join(rootAbs, filepath.Clean(relativePath)))
	if err != nil {
		return "", fmt.Errorf("resolve library file: %w", err)
	}
	rel, err := filepath.Rel(rootAbs, joinedAbs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", ErrUnsafePath
	}
	return joinedAbs, nil
}

func detectFormat(path string) (string, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", "", fmt.Errorf("open staged file: %w", err)
	}
	defer file.Close()

	header := make([]byte, 512)
	n, err := file.Read(header)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", "", fmt.Errorf("read staged file header: %w", err)
	}
	header = header[:n]
	if bytes.HasPrefix(header, []byte("%PDF-")) {
		return "pdf", "application/pdf", nil
	}
	if http.DetectContentType(header) == "application/zip" && isEPUB(path) {
		return "epub", "application/epub+zip", nil
	}
	return "", "", ErrUnsupportedFormat
}

func isEPUB(path string) bool {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return false
	}
	defer archive.Close()
	for _, entry := range archive.File {
		if entry.Name != "mimetype" || entry.UncompressedSize64 > 128 {
			continue
		}
		reader, err := entry.Open()
		if err != nil {
			return false
		}
		content, err := io.ReadAll(io.LimitReader(reader, 128))
		_ = reader.Close()
		return err == nil && strings.TrimSpace(string(content)) == "application/epub+zip"
	}
	return false
}

func randomHex(bytesCount int) (string, error) {
	value := make([]byte, bytesCount)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}
