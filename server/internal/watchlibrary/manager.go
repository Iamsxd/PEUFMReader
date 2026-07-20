package watchlibrary

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"peufmreader/internal/library"
)

type Candidate struct {
	SourcePath       string
	OriginalFilename string
	SizeBytes        int64
	ModifiedAt       time.Time
	DedupeKey        string
}

type Manager struct {
	root string
}

func NewManager(root string) (*Manager, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("watched library root is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve watched library root: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, fmt.Errorf("open watched library root: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, fmt.Errorf("inspect watched library root: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("watched library root must be a directory")
	}
	return &Manager{root: resolved}, nil
}

func (m *Manager) Candidates() ([]Candidate, error) {
	items := make([]Candidate, 0)
	err := filepath.WalkDir(m.root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 || shouldIgnore(entry.Name()) || !supportedExtension(entry.Name()) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		relative, err := filepath.Rel(m.root, path)
		if err != nil || !filepath.IsLocal(relative) {
			return nil
		}
		relative = filepath.ToSlash(relative)
		items = append(items, Candidate{
			SourcePath: relative, OriginalFilename: filepath.Base(path), SizeBytes: info.Size(),
			ModifiedAt: info.ModTime(), DedupeKey: candidateKey(relative, info.Size(), info.ModTime()),
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("scan watched library: %w", err)
	}
	return items, nil
}

func (m *Manager) Open(sourcePath, dedupeKey string) (*os.File, error) {
	relative := filepath.FromSlash(strings.TrimSpace(sourcePath))
	path, err := library.SecureResolve(m.root, relative)
	if err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, fmt.Errorf("resolve watched file: %w", err)
	}
	contained, err := filepath.Rel(m.root, resolved)
	if err != nil || !filepath.IsLocal(contained) {
		return nil, library.ErrUnsafePath
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, fmt.Errorf("inspect watched file: %w", err)
	}
	if !info.Mode().IsRegular() || !supportedExtension(info.Name()) {
		return nil, errors.New("watched source is not a supported regular ebook file")
	}
	if candidateKey(filepath.ToSlash(relative), info.Size(), info.ModTime()) != strings.TrimSpace(dedupeKey) {
		return nil, errors.New("watched source changed after it was queued")
	}
	file, err := os.Open(resolved)
	if err != nil {
		return nil, fmt.Errorf("open watched file: %w", err)
	}
	return file, nil
}

func candidateKey(relative string, size int64, modifiedAt time.Time) string {
	identity := fmt.Sprintf("%s\x00%d\x00%d", filepath.ToSlash(relative), size, modifiedAt.UnixNano())
	hash := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(hash[:])
}

func supportedExtension(name string) bool {
	switch strings.ToLower(filepath.Ext(strings.TrimSpace(name))) {
	case ".pdf", ".epub", ".mobi", ".azw3":
		return true
	default:
		return false
	}
}

func shouldIgnore(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	return name == "" || strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".part") ||
		strings.HasSuffix(name, ".tmp") || strings.HasSuffix(name, ".crdownload")
}
