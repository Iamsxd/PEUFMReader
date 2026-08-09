package importing

import (
	"errors"
	"strings"
	"testing"

	"peufmreader/internal/library"
	"peufmreader/internal/metadata"
)

func TestMergeMetadataPrefersCalibreFieldsAndKeepsEmbeddedFallbacks(t *testing.T) {
	year := 2024
	merged := mergeMetadata(
		metadata.Result{Title: "Embedded", Language: "en", Publisher: "Embedded Publisher", Confidence: 0.7},
		metadata.Result{Title: "Calibre", Authors: []string{"Author"}, PublishedYear: &year, Source: "calibre-metadata-opf", Confidence: 0.98},
	)
	if merged.Title != "Calibre" || len(merged.Authors) != 1 || merged.Language != "en" || merged.Publisher != "Embedded Publisher" {
		t.Fatalf("unexpected merged metadata: %+v", merged)
	}
	if merged.Confidence != 0.98 || merged.Source != "calibre-metadata-opf" {
		t.Fatalf("unexpected provenance: %+v", merged)
	}
}

func TestFailureMessageExplainsUnsupportedFileStructure(t *testing.T) {
	tests := []struct {
		err  error
		want string
	}{
		{err: library.ErrEmptyEbook, want: "文件为空"},
		{err: library.ErrInvalidPDF, want: "%PDF-版本"},
		{err: library.ErrInvalidEPUBArchive, want: "不是可读取的 ZIP 容器"},
		{err: library.ErrMissingEPUBContainer, want: "缺少 META-INF/container.xml"},
		{err: library.ErrInvalidKindle, want: "BOOKMOBI"},
		{err: fmtWrappedUnsupported(), want: "无法从文件内容识别"},
	}
	for _, test := range tests {
		if message := FailureMessage(test.err); !strings.Contains(message, test.want) {
			t.Errorf("FailureMessage(%v) = %q, want substring %q", test.err, message, test.want)
		}
	}
}

func fmtWrappedUnsupported() error {
	return errors.Join(errors.New("format probe failed"), library.ErrUnsupportedFormat)
}
