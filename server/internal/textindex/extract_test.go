package textindex

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func syntheticEPUB(t *testing.T, href string) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	files := map[string]string{
		"META-INF/container.xml": `<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>`,
		"OPS/book.opf":           `<package><manifest><item id="one" href="` + href + `" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>`,
		"OPS/one.xhtml":          `<html><head><style>do not index styles</style></head><body><h1>原创章节</h1><p>原创测试正文，星空与海洋。</p><script>secret script text</script></body></html>`,
	}
	for name, content := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
func TestEPUBIndexesSpineAndExcludesExecutableContent(t *testing.T) {
	data := syntheticEPUB(t, "one.xhtml")
	passages, coverage, err := EPUB(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if len(passages) != 1 || passages[0].Label != "原创章节" || passages[0].Position["href"] != "one.xhtml" || !strings.Contains(passages[0].Body, "星空") || strings.Contains(passages[0].Body, "script") || strings.Contains(passages[0].Body, "styles") || coverage == "" {
		t.Fatalf("bad passage: %+v", passages)
	}
	for _, href := range []string{"https://example.invalid/one.xhtml", "../../../escape.xhtml", "/one.xhtml"} {
		data = syntheticEPUB(t, href)
		if _, _, err = EPUB(bytes.NewReader(data), int64(len(data))); err == nil {
			t.Fatalf("accepted unsafe href %s", href)
		}
	}
}
func TestPDFPageBreaksOCRCoverageAndUnknownPages(t *testing.T) {
	passages, coverage, err := PDF([]byte("原创第一页\f原创第二页\f"), "native", 2)
	if err != nil || len(passages) != 2 || passages[1].Position["pageIndex"] != 1 || !strings.Contains(coverage, "2 页") {
		t.Fatalf("page breaks: %+v %s %v", passages, coverage, err)
	}
	passages, coverage, err = PDF([]byte("--- 第 1 页 ---\n原创扫描文本\n--- 第 3 页 ---\n另一页原创文本"), "ocr", 30)
	if err != nil || len(passages) != 2 || passages[1].Position["pageIndex"] != 2 || !strings.Contains(coverage, "不保证全书覆盖") {
		t.Fatalf("OCR: %+v %s %v", passages, coverage, err)
	}
	passages, _, err = PDF([]byte("无法知道页码的原创文本"), "native", 50)
	if err != nil || len(passages[0].Position) != 0 {
		t.Fatal("fabricated a page number")
	}
	if _, _, err = PDF(bytes.Repeat([]byte("a"), MaxTextBytes+1), "native", 1); err == nil {
		t.Fatal("accepted oversized text")
	}
}
