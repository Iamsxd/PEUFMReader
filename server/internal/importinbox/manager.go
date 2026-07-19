package importinbox

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
	root          string
	inboxRoot     string
	failedRoot    string
	processedRoot string
}

func NewManager(root string) (*Manager, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("import root is required")
	}
	m := &Manager{
		root:          root,
		inboxRoot:     filepath.Join(root, "inbox"),
		failedRoot:    filepath.Join(root, "failed"),
		processedRoot: filepath.Join(root, "processed"),
	}
	for _, path := range []string{m.inboxRoot, m.failedRoot, m.processedRoot} {
		if err := os.MkdirAll(path, 0o750); err != nil {
			return nil, fmt.Errorf("create import directory %s: %w", path, err)
		}
	}
	return m, nil
}

func (m *Manager) Candidates() ([]Candidate, error) {
	items := make([]Candidate, 0)
	err := filepath.WalkDir(m.inboxRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || shouldIgnore(entry.Name()) {
			return nil
		}
		relative, err := filepath.Rel(m.inboxRoot, path)
		if err != nil || !filepath.IsLocal(relative) {
			return nil
		}
		relative = filepath.ToSlash(relative)
		identity := fmt.Sprintf("%s\x00%d\x00%d", relative, info.Size(), info.ModTime().UnixNano())
		hash := sha256.Sum256([]byte(identity))
		items = append(items, Candidate{
			SourcePath: relative, OriginalFilename: filepath.Base(path), SizeBytes: info.Size(),
			ModifiedAt: info.ModTime(), DedupeKey: hex.EncodeToString(hash[:]),
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("scan import inbox: %w", err)
	}
	return items, nil
}

func shouldIgnore(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	return name == "" || strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".part") ||
		strings.HasSuffix(name, ".tmp") || strings.HasSuffix(name, ".crdownload")
}

func (m *Manager) Open(sourcePath, dedupeKey string) (*os.File, error) {
	path, err := m.resolveSource(sourcePath, dedupeKey)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open inbox file: %w", err)
	}
	return file, nil
}

func (m *Manager) Complete(sourcePath, dedupeKey string) (string, error) {
	source, err := m.resolveSource(sourcePath, dedupeKey)
	if err != nil {
		return "", err
	}
	destinationDir := filepath.Join(m.processedRoot, time.Now().UTC().Format("2006-01"))
	if err := os.MkdirAll(destinationDir, 0o750); err != nil {
		return "", fmt.Errorf("create processed import directory: %w", err)
	}
	destination := filepath.Join(destinationDir, shortKey(dedupeKey)+"-"+filepath.Base(sourcePath))
	if err := os.Rename(source, destination); err != nil {
		return "", fmt.Errorf("archive imported file: %w", err)
	}
	return filepath.ToSlash(destination), nil
}

func (m *Manager) Quarantine(sourcePath, dedupeKey string, failure error) (string, error) {
	source, err := m.resolveSource(sourcePath, dedupeKey)
	if err != nil {
		return "", err
	}
	destinationDir := filepath.Join(m.failedRoot, shortKey(dedupeKey))
	if err := os.MkdirAll(destinationDir, 0o750); err != nil {
		return "", fmt.Errorf("create failed import directory: %w", err)
	}
	destination := filepath.Join(destinationDir, filepath.Base(sourcePath))
	if source != destination {
		if err := os.Rename(source, destination); err != nil {
			return "", fmt.Errorf("quarantine failed import: %w", err)
		}
	}
	message := "导入失败\n" + time.Now().Format(time.RFC3339) + "\n" + failure.Error() + "\n"
	if err := os.WriteFile(destination+".error.txt", []byte(message), 0o640); err != nil {
		return "", fmt.Errorf("write quarantine reason: %w", err)
	}
	return filepath.ToSlash(destination), nil
}

func (m *Manager) resolveSource(sourcePath, dedupeKey string) (string, error) {
	relative := filepath.FromSlash(sourcePath)
	if path, err := library.SecureResolve(m.inboxRoot, relative); err == nil {
		if _, statErr := os.Stat(path); statErr == nil {
			return path, nil
		}
	}
	failedRelative := filepath.Join(shortKey(dedupeKey), filepath.Base(relative))
	path, err := library.SecureResolve(m.failedRoot, failedRelative)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("inbox source no longer exists: %w", err)
	}
	return path, nil
}

func shortKey(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 16 {
		return value[:16]
	}
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:8])
}
