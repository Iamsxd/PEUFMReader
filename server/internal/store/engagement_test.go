package store

import (
	"strings"
	"testing"
)

func TestRecommendationReasonPrefersCreatorThenCategory(t *testing.T) {
	creatorReason := recommendationReason(recommendationMetric{Creator: "刘慈欣", CreatorFit: 4, Category: "科幻", CategoryFit: 5})
	if !strings.Contains(creatorReason, "刘慈欣") {
		t.Fatalf("creator reason was not selected: %q", creatorReason)
	}
	categoryReason := recommendationReason(recommendationMetric{Category: "科幻", CategoryFit: 5})
	if !strings.Contains(categoryReason, "科幻") {
		t.Fatalf("category reason was not selected: %q", categoryReason)
	}
}

func TestRecommendationReasonHasFallbacks(t *testing.T) {
	if got := recommendationReason(recommendationMetric{HeatScore: 10}); got != "书库近期热门" {
		t.Fatalf("unexpected hot fallback: %q", got)
	}
	if got := recommendationReason(recommendationMetric{}); got != "最近加入书库" {
		t.Fatalf("unexpected new-book fallback: %q", got)
	}
}
