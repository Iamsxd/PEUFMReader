package mobiconvert

import (
	"archive/zip"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEnsureEPUBConvertsOnceAndCaches(t *testing.T) {
	root := t.TempDir()
	converter, err := New(root, "fake-mobitool", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	converter.run = func(_ context.Context, binary, sourcePath, outputDir string) ([]byte, error) {
		calls++
		if binary != "fake-mobitool" || filepath.Base(sourcePath) != "book.azw3" {
			t.Fatalf("unexpected converter arguments: %s %s", binary, sourcePath)
		}
		return nil, os.WriteFile(filepath.Join(outputDir, "book.epub"), testEPUB(t), 0o600)
	}
	source := filepath.Join(root, "book.azw3")
	if err := os.WriteFile(source, []byte("kindle source"), 0o600); err != nil {
		t.Fatal(err)
	}
	hash := strings.Repeat("a", 64)
	first, err := converter.EnsureEPUB(context.Background(), source, "azw3", hash)
	if err != nil || !first.Created || !validEPUB(first.Path) {
		t.Fatalf("first conversion=%+v err=%v", first, err)
	}
	second, err := converter.EnsureEPUB(context.Background(), source, "azw3", hash)
	if err != nil || second.Created || second.Path != first.Path || calls != 1 {
		t.Fatalf("cached conversion=%+v calls=%d err=%v", second, calls, err)
	}
}

func TestKindleFormats(t *testing.T) {
	for _, format := range []string{"mobi", "MOBI", "azw3"} {
		if !IsKindleFormat(format) {
			t.Fatalf("Kindle format rejected: %s", format)
		}
	}
	if IsKindleFormat("epub") {
		t.Fatal("EPUB identified as Kindle format")
	}
}

func testEPUB(t *testing.T) []byte {
	t.Helper()
	buffer := new(bytes.Buffer)
	writer := zip.NewWriter(buffer)
	header := &zip.FileHeader{Name: "mimetype", Method: zip.Store}
	entry, err := writer.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte("application/epub+zip")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
