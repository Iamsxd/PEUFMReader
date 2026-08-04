package httpapi

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"peufmreader/internal/store"
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

func TestNormalizedRequestRouteDoesNotDuplicateMethod(t *testing.T) {
	request := &http.Request{Method: http.MethodGet, Pattern: "GET /api/v1/book-files/{id}"}
	if got, want := normalizedRequestRoute(request), "GET /api/v1/book-files/{id}"; got != want {
		t.Fatalf("normalizedRequestRoute()=%q, want %q", got, want)
	}
	request.Pattern = ""
	if got, want := normalizedRequestRoute(request), "GET UNMATCHED"; got != want {
		t.Fatalf("unmatched route=%q, want %q", got, want)
	}
}

func TestEvaluateOperationsHealthUsesConfiguredThresholds(t *testing.T) {
	thresholds := OperationsThresholds{
		DiskWarningPercent: 80, DiskCriticalPercent: 90,
		QueueWarningSeconds: 60, QueueCriticalSeconds: 300,
		FailedJobsWarning: 2, FailedJobsCritical: 4,
	}
	health := evaluateOperationsHealth(
		store.OperationsSnapshot{OldestQueuedSeconds: 301, FailedJobsLast24Hours: 2},
		[]OperationsDisk{{Label: "library", Available: true, UsedPercent: 85}},
		thresholds,
	)
	if health.Status != "critical" {
		t.Fatalf("status=%q, want critical", health.Status)
	}
	if len(health.Issues) != 3 {
		t.Fatalf("issues=%d, want disk, queue, and failed-job issues", len(health.Issues))
	}
	if health.Issues[0].Severity != "warning" || health.Issues[1].Severity != "critical" {
		t.Fatalf("unexpected issue severities: %#v", health.Issues)
	}
}

func TestEvaluateOperationsHealthTreatsUnavailableDiskAsCritical(t *testing.T) {
	health := evaluateOperationsHealth(store.OperationsSnapshot{}, []OperationsDisk{{Label: "cache"}}, OperationsThresholds{
		DiskWarningPercent: 85, DiskCriticalPercent: 95,
		QueueWarningSeconds: 300, QueueCriticalSeconds: 1800,
		FailedJobsWarning: 1, FailedJobsCritical: 5,
	})
	if health.Status != "critical" || len(health.Issues) != 1 || health.Issues[0].Code != "disk_unavailable" {
		t.Fatalf("unexpected health: %#v", health)
	}
}

func TestPrometheusLabelEscapesSpecialCharacters(t *testing.T) {
	if got, want := prometheusLabel("a\\b\n\"c"), `a\\b\n\"c`; got != want {
		t.Fatalf("prometheusLabel()=%q, want %q", got, want)
	}
}

func TestRenderPrometheusUsesTypedFamiliesAndSafeLabels(t *testing.T) {
	output := renderPrometheus(OperationsOverview{
		Health:   OperationsHealth{Status: "warning"},
		Disks:    []OperationsDisk{{Label: `library\"one`, Available: true, TotalBytes: 100, AvailableBytes: 25, UsedPercent: 75}},
		Requests: []RequestMetricSnapshot{{Route: "GET /api/v1/book-files/{id}", Requests: 3, Errors: 1, P95DurationMS: 250}},
	})
	for _, expected := range []string{
		"# TYPE peufmreader_http_requests_total counter",
		`peufmreader_disk_available{root="library\\\"one"} 1`,
		`peufmreader_http_requests_total{route="GET /api/v1/book-files/{id}"} 3`,
		"peufmreader_health_status 1",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("Prometheus output missing %q:\n%s", expected, output)
		}
	}
}
