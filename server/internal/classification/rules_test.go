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

func TestClassifyAcceptsDistinctiveChineseTitleSignals(t *testing.T) {
	tests := []struct {
		title string
		slug  string
	}{
		{title: "朱子家训", slug: "chinese-classics"},
		{title: "极简主义生活指南", slug: "minimalist-living"},
		{title: "i人社会化攻略2.0", slug: "interpersonal-communication"},
	}
	for _, test := range tests {
		t.Run(test.title, func(t *testing.T) {
			result := Classify(metadata.Result{Title: test.title})
			if len(result) == 0 || result[0].CategorySlug != test.slug || result[0].Status != "accepted" {
				t.Fatalf("classification for %q = %+v", test.title, result)
			}
		})
	}
}

func TestClassifyCombinesEvidenceAcrossFields(t *testing.T) {
	rules := []Rule{{Slug: "technology", Keywords: []string{"建筑营造"}}}
	result := ClassifyWithRules(metadata.Result{Title: "建筑营造入门", Description: "建筑营造实践教程"}, rules)
	if len(result) != 1 || result[0].Status != "accepted" || result[0].Confidence < autoAcceptThreshold {
		t.Fatalf("combined classification = %+v", result)
	}
}

func TestClassifyWithEmptyConfiguredRulesDoesNotRestoreDefaults(t *testing.T) {
	result := ClassifyWithRules(metadata.Result{Title: "科幻小说"}, []Rule{})
	if len(result) != 1 || result[0].CategorySlug != "other" {
		t.Fatalf("empty configured rules should fall back to other: %+v", result)
	}
}

func TestDefaultRulesCoverEveryBuiltInCategoryExceptOther(t *testing.T) {
	want := []string{
		"nonfiction", "lifestyle", "religion-spirituality", "classics", "contemporary-fiction",
		"historical-fiction", "horror", "humor", "poetry", "essays", "true-crime", "comics",
		"photography", "film-theater", "psychology", "politics-law", "military", "management",
		"finance-investment", "marketing", "programming", "ai-data", "cybersecurity", "engineering",
		"mathematics", "earth-environment", "medicine", "sports-fitness", "self-help", "cooking-food",
		"parenting-family", "home-gardening", "crafts-hobbies", "language-learning", "exams",
	}
	have := make(map[string]bool)
	for _, rule := range DefaultRules() {
		have[rule.Slug] = true
	}
	for _, slug := range want {
		if !have[slug] {
			t.Errorf("missing default rule for %s", slug)
		}
	}
}
