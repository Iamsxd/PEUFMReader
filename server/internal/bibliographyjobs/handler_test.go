package bibliographyjobs

import (
	"testing"

	"peufmreader/internal/bibliography"
	"peufmreader/internal/classification"
)

func TestSuggestionsForHighConfidenceBibliographyMatch(t *testing.T) {
	rules := []classification.Rule{{Slug: "essays", StrongKeywords: []string{"散文集"}}}
	result := suggestionsForMatch(bibliography.Match{
		Source: "douban", Title: "一个人的村庄", Subjects: []string{"散文集"}, Confidence: 0.9,
	}, rules)
	if len(result) != 1 || result[0].CategorySlug != "essays" || result[0].Status != "accepted" {
		t.Fatalf("suggestions = %+v", result)
	}
	if result[0].Source != "bibliography-rules-v2:douban" || result[0].Confidence != 0.9 {
		t.Fatalf("suggestion provenance = %+v", result[0])
	}
}

func TestSuggestionsForTitleOnlyMatchRequiresReview(t *testing.T) {
	rules := []classification.Rule{{Slug: "essays", StrongKeywords: []string{"散文集"}}}
	result := suggestionsForMatch(bibliography.Match{
		Source: "douban", Title: "一个人的村庄", Subjects: []string{"散文集"}, Confidence: 0.82,
	}, rules)
	if len(result) != 1 || result[0].Status != "suggested" {
		t.Fatalf("suggestions = %+v", result)
	}
}

func TestSuggestionsIgnoreUninformativeBibliographyMatch(t *testing.T) {
	result := suggestionsForMatch(bibliography.Match{Source: "douban", Title: "未知书名", Confidence: 0.9}, classification.DefaultRules())
	if len(result) != 0 {
		t.Fatalf("suggestions = %+v", result)
	}
}
