package importinbox

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestManagerScansArchivesAndQuarantinesFiles(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager(root)
	if err != nil {
		t.Fatal(err)
	}
	inboxFile := filepath.Join(root, "inbox", "nested", "sample.pdf")
	if err := os.MkdirAll(filepath.Dir(inboxFile), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(inboxFile, []byte("%PDF-test"), 0o640); err != nil {
		t.Fatal(err)
	}
	candidates, err := manager.Candidates()
	if err != nil || len(candidates) != 1 {
		t.Fatalf("candidates=%v err=%v", candidates, err)
	}
	candidate := candidates[0]
	if candidate.SourcePath != "nested/sample.pdf" || candidate.DedupeKey == "" {
		t.Fatalf("unexpected candidate: %#v", candidate)
	}
	quarantined, err := manager.Quarantine(candidate.SourcePath, candidate.DedupeKey, errors.New("invalid PDF"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.FromSlash(quarantined) + ".error.txt"); err != nil {
		t.Fatalf("quarantine reason missing: %v", err)
	}
	file, err := manager.Open(candidate.SourcePath, candidate.DedupeKey)
	if err != nil {
		t.Fatalf("quarantined file must remain retryable: %v", err)
	}
	_ = file.Close()
	processed, err := manager.Complete(candidate.SourcePath, candidate.DedupeKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.FromSlash(processed)); err != nil {
		t.Fatalf("processed archive missing: %v", err)
	}
}
