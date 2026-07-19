package library

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
)

func TestStorageAuditReportsMissingMismatchedAndOrphanedFiles(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager(filepath.Join(root, "library"), filepath.Join(root, "staging"), filepath.Join(root, "cache"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	validContent := []byte("valid book")
	validHash := sha256.Sum256(validContent)
	validPath := filepath.Join(root, "library", "aa", "valid.pdf")
	if err := os.MkdirAll(filepath.Dir(validPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(validPath, validContent, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "library", "orphan.epub"), []byte("orphan"), 0o640); err != nil {
		t.Fatal(err)
	}
	report, err := manager.Audit([]ExpectedFile{
		{BookFileID: 1, Path: "aa/valid.pdf", SizeBytes: int64(len(validContent)), SHA256: validHash[:]},
		{BookFileID: 2, Path: "bb/missing.pdf", SizeBytes: 20, SHA256: make([]byte, sha256.Size)},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if report.DatabaseFileCount != 2 || report.DiskFileCount != 2 || report.MissingCount != 1 || report.OrphanCount != 1 || report.MismatchCount != 0 {
		t.Fatalf("unexpected report: %#v", report)
	}
}
