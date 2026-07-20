package metadata

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestExtractEPUBMetadataAndCover(t *testing.T) {
	buffer := new(bytes.Buffer)
	writer := zip.NewWriter(buffer)
	writeZipFile(t, writer, "mimetype", []byte("application/epub+zip"))
	writeZipFile(t, writer, "META-INF/container.xml", []byte(`
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`))
	writeZipFile(t, writer, "OPS/book.opf", []byte(`
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title> 三体 </dc:title><dc:creator>刘慈欣</dc:creator>
    <dc:language>zh-CN</dc:language><dc:date>2008-01-01</dc:date>
    <dc:identifier>ISBN 978-7-5366-9293-0</dc:identifier>
    <dc:publisher>重庆出版社</dc:publisher><dc:subject>科幻</dc:subject>
    <dc:description><![CDATA[<p>地球往事。</p>]]></dc:description>
  </metadata>
  <manifest><item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/></manifest>
</package>`))
	cover := []byte{0xff, 0xd8, 0xff, 0xd9}
	writeZipFile(t, writer, "OPS/cover.jpg", cover)
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(t.TempDir(), "book.epub")
	if err := os.WriteFile(filePath, buffer.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	result, err := Extract(filePath, "epub", "fallback.epub")
	if err != nil {
		t.Fatal(err)
	}
	if result.Title != "三体" || len(result.Authors) != 1 || result.Authors[0] != "刘慈欣" {
		t.Fatalf("unexpected title/authors: %+v", result)
	}
	if result.PublishedYear == nil || *result.PublishedYear != 2008 || result.ISBN != "9787536692930" {
		t.Fatalf("unexpected publication metadata: %+v", result)
	}
	if !EqualCover(result.Cover, &Cover{Bytes: cover, Extension: "jpg", MIMEType: "image/jpeg"}) {
		t.Fatalf("unexpected cover: %+v", result.Cover)
	}
}

func TestExtractPDFInfo(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "book.pdf")
	content := []byte("%PDF-1.7\n1 0 obj << /Title (Clean\\040Code) /Author (Robert C. Martin) /Subject (technology; programming) /CreationDate (D:20080801) >> endobj\ntrailer << /Info 1 0 R >>")
	if err := os.WriteFile(filePath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := Extract(filePath, "pdf", "fallback.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if result.Title != "Clean Code" || len(result.Authors) != 1 || result.Authors[0] != "Robert C. Martin" {
		t.Fatalf("unexpected PDF metadata: %+v", result)
	}
	if result.PublishedYear == nil || *result.PublishedYear != 2008 || len(result.Subjects) != 2 {
		t.Fatalf("unexpected PDF year/subjects: %+v", result)
	}
}

func TestExtractPDFUsesDocumentInfoInsteadOfBookmarkTitle(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "book.pdf")
	content := []byte("%PDF-1.7\n1 0 obj << /Title (封面) >> endobj\n7 0 obj << /Title (真正书名) /Author (作者) >> endobj\ntrailer << /Info 7 0 R >>")
	if err := os.WriteFile(filePath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := Extract(filePath, "pdf", "文件名.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if result.Title != "真正书名" || len(result.Authors) != 1 || result.Authors[0] != "作者" {
		t.Fatalf("unexpected PDF Info selection: %+v", result)
	}
}

func TestExtractPDFFallsBackWhenInfoTitleIsPlaceholder(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "book.pdf")
	content := []byte("%PDF-1.7\n2 0 obj << /Title (封面) /CreationDate (D:20220101) >> endobj\ntrailer << /Info 2 0 R >>")
	if err := os.WriteFile(filePath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := Extract(filePath, "pdf", "一个人的村庄.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if result.Title != "一个人的村庄" || result.Source != "filename" || result.Confidence != 0.35 {
		t.Fatalf("placeholder title did not fall back to filename: %+v", result)
	}
	if result.PublishedYear == nil || *result.PublishedYear != 2022 || len(result.Warnings) == 0 {
		t.Fatalf("useful PDF Info fields or warning were lost: %+v", result)
	}
}

func TestExtractFallsBackToFilename(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "book.pdf")
	if err := os.WriteFile(filePath, []byte("%PDF-1.4\nminimal"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := Extract(filePath, "pdf", "The Book.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if result.Title != "The Book" || result.Source != "filename" || result.Confidence >= 0.8 {
		t.Fatalf("unexpected fallback: %+v", result)
	}
}

func writeZipFile(t *testing.T, writer *zip.Writer, name string, content []byte) {
	t.Helper()
	entry, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write(content); err != nil {
		t.Fatal(err)
	}
}
