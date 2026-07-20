package calibre

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPreviewAndLoadCalibreLibrary(t *testing.T) {
	root := t.TempDir()
	bookDir := filepath.Join(root, "Liu Cixin", "The Three-Body Problem (1)")
	if err := os.MkdirAll(bookDir, 0o750); err != nil {
		t.Fatal(err)
	}
	opf := `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata>
<dc:title>三体</dc:title><dc:creator>刘慈欣</dc:creator><dc:date>2008-01-01</dc:date>
<dc:language>zh</dc:language><dc:publisher>重庆出版社</dc:publisher>
<dc:identifier scheme="ISBN">9787536692930</dc:identifier><dc:subject>科幻</dc:subject>
</metadata></package>`
	if err := os.WriteFile(filepath.Join(bookDir, "metadata.opf"), []byte(opf), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bookDir, "Three Body.pdf"), []byte("%PDF-1.7\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Three Body.mobi", "Three Body.azw3"} {
		content := make([]byte, 96)
		copy(content[60:68], []byte("BOOKMOBI"))
		if err := os.WriteFile(filepath.Join(bookDir, name), content, 0o640); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(bookDir, "cover.jpg"), []byte{0xff, 0xd8, 0xff, 0xd9}, 0o640); err != nil {
		t.Fatal(err)
	}

	scanner := NewScanner(root)
	preview, err := scanner.Preview(100)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Total != 3 || preview.PDFCount != 1 || preview.MOBICount != 1 || preview.AZW3Count != 1 || len(preview.Books) != 3 {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	record, absolute, err := scanner.Load(preview.Books[0].SourcePath)
	if err != nil {
		t.Fatal(err)
	}
	if record.Title != "三体" || len(record.Authors) != 1 || record.ISBN != "9787536692930" || absolute == "" {
		t.Fatalf("unexpected record: %+v", record)
	}
	result, err := scanner.Metadata(record)
	if err != nil || result.Cover == nil || result.Source != "calibre-metadata-opf" {
		t.Fatalf("unexpected metadata: %+v err=%v", result, err)
	}
}

func TestLoadRejectsPathTraversal(t *testing.T) {
	_, _, err := NewScanner(t.TempDir()).Load("../outside.pdf")
	if err == nil {
		t.Fatal("expected unsafe Calibre path to fail")
	}
}
