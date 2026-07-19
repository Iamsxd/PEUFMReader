package library

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSecureResolve(t *testing.T) {
	root := t.TempDir()
	path, err := SecureResolve(root, filepath.Join("ab", "book.pdf"))
	if err != nil {
		t.Fatalf("SecureResolve returned error: %v", err)
	}
	if want := filepath.Join(root, "ab", "book.pdf"); path != want {
		t.Fatalf("got %q, want %q", path, want)
	}

	unsafe := []string{"", "..", filepath.Join("..", "secret"), filepath.Join(root, "absolute.pdf")}
	for _, value := range unsafe {
		if _, err := SecureResolve(root, value); err == nil {
			t.Fatalf("unsafe path %q was accepted", value)
		}
	}
}

func TestIngestPDFAndDeduplicate(t *testing.T) {
	manager, err := NewManager(filepath.Join(t.TempDir(), "library"), filepath.Join(t.TempDir(), "staging"), filepath.Join(t.TempDir(), "cache"), 1024)
	if err != nil {
		t.Fatalf("NewManager returned error: %v", err)
	}
	content := []byte("%PDF-1.7\nminimal test data")
	first, err := manager.Ingest("Example.pdf", bytes.NewReader(content))
	if err != nil {
		t.Fatalf("first ingest returned error: %v", err)
	}
	if !first.Created || first.Format != "pdf" {
		t.Fatalf("unexpected first ingest result: %+v", first)
	}
	second, err := manager.Ingest("Duplicate.pdf", bytes.NewReader(content))
	if err != nil {
		t.Fatalf("second ingest returned error: %v", err)
	}
	if second.Created || second.RelativePath != first.RelativePath {
		t.Fatalf("duplicate was not detected: %+v", second)
	}
}

func TestIngestEPUB(t *testing.T) {
	buffer := new(bytes.Buffer)
	writer := zip.NewWriter(buffer)
	mimetype, err := writer.CreateHeader(&zip.FileHeader{Name: "mimetype", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = mimetype.Write([]byte("application/epub+zip"))
	container, _ := writer.Create("META-INF/container.xml")
	_, _ = container.Write([]byte("<container/>"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	manager, err := NewManager(filepath.Join(t.TempDir(), "library"), filepath.Join(t.TempDir(), "staging"), filepath.Join(t.TempDir(), "cache"), 4096)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := manager.Ingest("Example.epub", bytes.NewReader(buffer.Bytes()))
	if err != nil {
		t.Fatalf("ingest EPUB returned error: %v", err)
	}
	if stored.Format != "epub" || stored.MIMEType != "application/epub+zip" {
		t.Fatalf("unexpected EPUB result: %+v", stored)
	}
	if _, err := os.Stat(stored.AbsolutePath); err != nil {
		t.Fatalf("managed EPUB missing: %v", err)
	}
}

func TestStoreCover(t *testing.T) {
	manager, err := NewManager(filepath.Join(t.TempDir(), "library"), filepath.Join(t.TempDir(), "staging"), filepath.Join(t.TempDir(), "cache"), 4096)
	if err != nil {
		t.Fatal(err)
	}
	hash := "68d3dbe223d4659eb030429ecc280a437eb6e9b042a59797cbbd9e16f56c1d56"
	relativePath, err := manager.StoreCover(hash, "jpg", []byte{0xff, 0xd8, 0xff, 0xd9})
	if err != nil {
		t.Fatal(err)
	}
	absolutePath, err := manager.ResolveCover(relativePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(absolutePath); err != nil {
		t.Fatalf("cached cover missing: %v", err)
	}
}

func TestStoreExtractedText(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager(filepath.Join(root, "library"), filepath.Join(root, "staging"), filepath.Join(root, "cache"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	hash := strings.Repeat("a", 64)
	relativePath, err := manager.StoreExtractedText(hash, []byte("第一页 OCR 文本"))
	if err != nil {
		t.Fatal(err)
	}
	absolutePath, err := manager.ResolveExtractedText(relativePath)
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(absolutePath)
	if err != nil || string(content) != "第一页 OCR 文本" {
		t.Fatalf("unexpected text cache %q err=%v", content, err)
	}
}
