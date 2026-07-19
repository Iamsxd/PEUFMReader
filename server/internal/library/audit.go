package library

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const maxReportedStorageIssues = 100

type ExpectedFile struct {
	BookFileID int64
	Path       string
	SizeBytes  int64
	SHA256     []byte
}

type StorageIssue struct {
	BookFileID *int64 `json:"bookFileId,omitempty"`
	Path       string `json:"path"`
	Issue      string `json:"issue"`
}

type StorageAuditReport struct {
	CheckedAt         time.Time      `json:"checkedAt"`
	Deep              bool           `json:"deep"`
	DatabaseFileCount int            `json:"databaseFileCount"`
	DiskFileCount     int            `json:"diskFileCount"`
	ExpectedBytes     int64          `json:"expectedBytes"`
	ActualBytes       int64          `json:"actualBytes"`
	MissingCount      int            `json:"missingCount"`
	MismatchCount     int            `json:"mismatchCount"`
	OrphanCount       int            `json:"orphanCount"`
	Issues            []StorageIssue `json:"issues"`
}

func (m *Manager) Audit(expected []ExpectedFile, deep bool) (StorageAuditReport, error) {
	report := StorageAuditReport{
		CheckedAt: time.Now().UTC(), Deep: deep, DatabaseFileCount: len(expected), Issues: make([]StorageIssue, 0),
	}
	expectedByPath := make(map[string]ExpectedFile, len(expected))
	for _, item := range expected {
		item.Path = filepath.ToSlash(filepath.Clean(filepath.FromSlash(item.Path)))
		expectedByPath[item.Path] = item
		report.ExpectedBytes += item.SizeBytes
	}

	err := filepath.WalkDir(m.libraryRoot, func(path string, entry os.DirEntry, walkErr error) error {
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
		if !info.Mode().IsRegular() {
			return nil
		}
		relative, err := filepath.Rel(m.libraryRoot, path)
		if err != nil || !filepath.IsLocal(relative) {
			return nil
		}
		relative = filepath.ToSlash(relative)
		report.DiskFileCount++
		report.ActualBytes += info.Size()
		if _, exists := expectedByPath[relative]; !exists {
			report.OrphanCount++
			report.addIssue(StorageIssue{Path: relative, Issue: "orphaned"})
		}
		return nil
	})
	if err != nil {
		return report, fmt.Errorf("walk managed library: %w", err)
	}

	for _, item := range expected {
		absolute, err := SecureResolve(m.libraryRoot, filepath.FromSlash(item.Path))
		if err != nil {
			id := item.BookFileID
			report.MismatchCount++
			report.addIssue(StorageIssue{BookFileID: &id, Path: item.Path, Issue: "unsafe_path"})
			continue
		}
		info, err := os.Stat(absolute)
		if os.IsNotExist(err) {
			id := item.BookFileID
			report.MissingCount++
			report.addIssue(StorageIssue{BookFileID: &id, Path: item.Path, Issue: "missing"})
			continue
		}
		if err != nil {
			return report, fmt.Errorf("inspect managed file %s: %w", item.Path, err)
		}
		if !info.Mode().IsRegular() || info.Size() != item.SizeBytes {
			id := item.BookFileID
			report.MismatchCount++
			report.addIssue(StorageIssue{BookFileID: &id, Path: item.Path, Issue: "size_mismatch"})
			continue
		}
		if deep {
			matches, err := fileMatchesSHA256(absolute, item.SHA256)
			if err != nil {
				return report, err
			}
			if !matches {
				id := item.BookFileID
				report.MismatchCount++
				report.addIssue(StorageIssue{BookFileID: &id, Path: item.Path, Issue: "checksum_mismatch"})
			}
		}
	}
	return report, nil
}

func (r *StorageAuditReport) addIssue(issue StorageIssue) {
	if len(r.Issues) < maxReportedStorageIssues {
		r.Issues = append(r.Issues, issue)
	}
}

func fileMatchesSHA256(path string, expected []byte) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, fmt.Errorf("open managed file for checksum: %w", err)
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return false, fmt.Errorf("checksum managed file: %w", err)
	}
	return bytes.Equal(hasher.Sum(nil), expected), nil
}
