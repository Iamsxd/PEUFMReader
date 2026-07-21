package classification

import (
	"testing"

	"peufmreader/internal/metadata"
)

func TestClassifyAcceptsExactEmbeddedSubject(t *testing.T) {
	result := Classify(metadata.Result{Title: "三体", Subjects: []string{"科幻"}})
	if len(result) == 0 || result[0].CategorySlug != "science-fiction" || result[0].Status != "accepted" {
		t.Fatalf("unexpected classification: %+v", result)
	}
}

func TestClassifyUsesSpecificProgrammingCategoryForTitleMatch(t *testing.T) {
	result := Classify(metadata.Result{Title: "A Programming Handbook"})
	if len(result) == 0 || result[0].CategorySlug != "programming" || result[0].Status != "suggested" {
		t.Fatalf("unexpected classification: %+v", result)
	}
}

func TestClassifyFallsBackToOther(t *testing.T) {
	result := Classify(metadata.Result{Title: "Unmatched title"})
	if len(result) != 1 || result[0].CategorySlug != "other" || result[0].Confidence >= 0.5 {
		t.Fatalf("unexpected fallback: %+v", result)
	}
}

func TestClassifyWithRulesUsesAdministratorKeywords(t *testing.T) {
	result := ClassifyWithRules(metadata.Result{Title: "建筑营造入门"}, []Rule{{Slug: "technology", Keywords: []string{"建筑营造"}}})
	if len(result) != 1 || result[0].CategorySlug != "technology" || result[0].Confidence < 0.7 {
		t.Fatalf("custom classification result = %#v", result)
	}
}
