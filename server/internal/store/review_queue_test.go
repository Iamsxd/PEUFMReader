package store

import (
	"strings"
	"testing"
)

func TestReviewQueuePaginationBoundsLargeLibraries(t *testing.T) {
	query := NormalizeReviewQueueQuery(ReviewQueueQuery{Page: -1, PageSize: 3336})
	if query.Page != 1 || query.PageSize != DefaultReviewQueuePageSize {
		t.Fatalf("large queue was not bounded: %#v", query)
	}
	if DefaultReviewQueuePageSize != 20 || MaxReviewQueuePageSize != 100 {
		t.Fatalf("unexpected review queue limits: default=%d max=%d", DefaultReviewQueuePageSize, MaxReviewQueuePageSize)
	}
}

func TestBuildReviewQueueWhereUsesBoundFilters(t *testing.T) {
	where, args := buildReviewQueueWhere(ReviewQueueQuery{Query: `100%_Go`, Format: "pdf", Reason: "classification"})
	if len(args) != 2 || args[0] != `100\%\_Go` || args[1] != "pdf" {
		t.Fatalf("unexpected review queue arguments: %#v", args)
	}
	if strings.Contains(where, `100%_Go`) || !strings.Contains(where, "bf.format=$2") || !strings.Contains(where, "reason_cd.status='suggested'") {
		t.Fatalf("review queue filters were not safely bound: %s", where)
	}
}

func TestReviewQueueSummaryDoesNotLoadFullEvidence(t *testing.T) {
	if strings.Contains(reviewQueueSummarySelect, "jsonb_build_object") || strings.Contains(reviewQueueSummarySelect, "mc.value") {
		t.Fatal("review queue summary unexpectedly includes full metadata evidence")
	}
	if !strings.Contains(reviewQueueSummarySelect, "SELECT COUNT(*) FROM metadata_candidates") {
		t.Fatal("review queue summary does not expose the evidence count")
	}
}
