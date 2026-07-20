package watchlibrary

import (
	"os"
	"path/filepath"
	"testing"
)

func TestManagerScansSupportedBooksAndKeepsSources(t *testing.T) {
	root := t.TempDir()
	bookPath := filepath.Join(root, "作者", "book.EPUB")
	if err := os.MkdirAll(filepath.Dir(bookPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bookPath, []byte("ebook"), 0o640); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"notes.txt", "partial.pdf.part", ".hidden.pdf"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("ignored"), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	manager, err := NewManager(root)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := manager.Candidates()
	if err != nil || len(candidates) != 1 {
		t.Fatalf("candidates=%#v err=%v", candidates, err)
	}
	candidate := candidates[0]
	if candidate.SourcePath != "作者/book.EPUB" || candidate.DedupeKey == "" {
		t.Fatalf("unexpected candidate: %#v", candidate)
	}
	file, err := manager.Open(candidate.SourcePath, candidate.DedupeKey)
	if err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	if _, err := os.Stat(bookPath); err != nil {
		t.Fatalf("source file was changed or removed: %v", err)
	}
}

func TestManagerRejectsChangedFileIdentity(t *testing.T) {
	root := t.TempDir()
	bookPath := filepath.Join(root, "book.pdf")
	if err := os.WriteFile(bookPath, []byte("first"), 0o640); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(root)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := manager.Candidates()
	if err != nil || len(candidates) != 1 {
		t.Fatalf("candidates=%#v err=%v", candidates, err)
	}
	if err := os.WriteFile(bookPath, []byte("second-version"), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Open(candidates[0].SourcePath, candidates[0].DedupeKey); err == nil {
		t.Fatal("changed watched file was accepted with a stale job identity")
	}
}
