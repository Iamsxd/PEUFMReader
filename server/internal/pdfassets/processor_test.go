package pdfassets

import "testing"

func TestHasMeaningfulTextUsesPageAwareThreshold(t *testing.T) {
	if !hasMeaningfulText([]byte("这是包含足够字符的文本页面，用于确认 PDF 原生文本不需要 OCR。1234567890"), 1) {
		t.Fatal("expected native text to be meaningful")
	}
	if hasMeaningfulText([]byte("扫描件"), 20) {
		t.Fatal("expected sparse text to trigger OCR")
	}
}

func TestPagesPattern(t *testing.T) {
	match := pagesPattern.FindStringSubmatch("Title: Demo\nPages:          97\nEncrypted: no\n")
	if len(match) != 2 || match[1] != "97" {
		t.Fatalf("unexpected page match %v", match)
	}
}
