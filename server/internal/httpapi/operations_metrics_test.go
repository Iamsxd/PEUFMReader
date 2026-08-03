package httpapi

import (
	"testing"
	"time"
)

func TestRequestMetricsKeepsRecentSamplesAndReportsP95(t *testing.T) {
	metrics := newRequestMetrics()
	for index := 1; index <= 100; index++ {
		metrics.record("GET /api/v1/book-files", 200, time.Duration(index)*time.Millisecond)
	}
	metrics.record("GET /api/v1/book-files", 500, 101*time.Millisecond)

	items := metrics.snapshot()
	if len(items) != 1 {
		t.Fatalf("metrics routes=%d, want 1", len(items))
	}
	item := items[0]
	if item.Requests != 101 || item.Errors != 1 || item.LastStatus != 500 {
		t.Fatalf("unexpected request counters: %#v", item)
	}
	if item.P95DurationMS < 95 || item.P95DurationMS > 101 {
		t.Fatalf("p95=%dms, want a high percentile of recent samples", item.P95DurationMS)
	}
}
