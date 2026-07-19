package importing

import (
	"testing"

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
