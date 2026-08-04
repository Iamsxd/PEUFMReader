package httpapi

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"peufmreader/internal/store"
)

const maxRequestDurationSamples = 200

type requestMetric struct {
	Requests        int
	Errors          int
	LastDuration    time.Duration
	LastStatus      int
	DurationSamples []time.Duration
}

type requestMetrics struct {
	mu     sync.Mutex
	routes map[string]*requestMetric
}

type RequestMetricSnapshot struct {
	Route          string `json:"route"`
	Requests       int    `json:"requests"`
	Errors         int    `json:"errors"`
	LastDurationMS int64  `json:"lastDurationMs"`
	P95DurationMS  int64  `json:"p95DurationMs"`
	LastStatus     int    `json:"lastStatus"`
}

type OperationsOverview struct {
	GeneratedAt     time.Time                       `json:"generatedAt"`
	UptimeSeconds   int64                           `json:"uptimeSeconds"`
	GoRoutines      int                             `json:"goRoutines"`
	HeapAllocBytes  uint64                          `json:"heapAllocBytes"`
	HeapSystemBytes uint64                          `json:"heapSystemBytes"`
	LastGCAt        *time.Time                      `json:"lastGcAt,omitempty"`
	Requests        []RequestMetricSnapshot         `json:"requests"`
	Snapshot        store.OperationsSnapshot        `json:"snapshot"`
	JobKinds        []store.BackgroundJobKindMetric `json:"jobKinds"`
	Disks           []OperationsDisk                `json:"disks"`
	Health          OperationsHealth                `json:"health"`
}

type OperationsDiskRoot struct {
	Label string
	Path  string
}

type OperationsThresholds struct {
	DiskWarningPercent   int   `json:"diskWarningPercent"`
	DiskCriticalPercent  int   `json:"diskCriticalPercent"`
	QueueWarningSeconds  int64 `json:"queueWarningSeconds"`
	QueueCriticalSeconds int64 `json:"queueCriticalSeconds"`
	FailedJobsWarning    int   `json:"failedJobsWarning"`
	FailedJobsCritical   int   `json:"failedJobsCritical"`
}

type OperationsConfig struct {
	DiskRoots             []OperationsDiskRoot
	Thresholds            OperationsThresholds
	PrometheusEnabled     bool
	PrometheusBearerToken string
}

type OperationsDisk struct {
	Label          string  `json:"label"`
	TotalBytes     uint64  `json:"totalBytes"`
	AvailableBytes uint64  `json:"availableBytes"`
	UsedPercent    float64 `json:"usedPercent"`
	Available      bool    `json:"available"`
}

type OperationsHealthIssue struct {
	Code      string  `json:"code"`
	Severity  string  `json:"severity"`
	Resource  string  `json:"resource"`
	Value     float64 `json:"value"`
	Threshold float64 `json:"threshold"`
}

type OperationsHealth struct {
	Status     string                  `json:"status"`
	Issues     []OperationsHealthIssue `json:"issues"`
	Thresholds OperationsThresholds    `json:"thresholds"`
}

type metricsResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (w *metricsResponseWriter) WriteHeader(statusCode int) {
	if w.statusCode != 0 {
		return
	}
	w.statusCode = statusCode
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *metricsResponseWriter) Write(content []byte) (int, error) {
	if w.statusCode == 0 {
		w.statusCode = http.StatusOK
	}
	return w.ResponseWriter.Write(content)
}

func newRequestMetrics() *requestMetrics {
	return &requestMetrics{routes: make(map[string]*requestMetric)}
}

func (m *requestMetrics) record(route string, statusCode int, duration time.Duration) {
	if m == nil || route == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	metric := m.routes[route]
	if metric == nil {
		metric = &requestMetric{}
		m.routes[route] = metric
	}
	metric.Requests++
	if statusCode >= http.StatusBadRequest {
		metric.Errors++
	}
	metric.LastDuration = duration
	metric.LastStatus = statusCode
	metric.DurationSamples = append(metric.DurationSamples, duration)
	if len(metric.DurationSamples) > maxRequestDurationSamples {
		metric.DurationSamples = append([]time.Duration(nil), metric.DurationSamples[len(metric.DurationSamples)-maxRequestDurationSamples:]...)
	}
}

func (m *requestMetrics) snapshot() []RequestMetricSnapshot {
	if m == nil {
		return []RequestMetricSnapshot{}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	items := make([]RequestMetricSnapshot, 0, len(m.routes))
	for route, metric := range m.routes {
		samples := append([]time.Duration(nil), metric.DurationSamples...)
		sort.Slice(samples, func(left, right int) bool { return samples[left] < samples[right] })
		p95 := time.Duration(0)
		if len(samples) > 0 {
			index := (len(samples)*95 + 99) / 100
			p95 = samples[min(len(samples)-1, index-1)]
		}
		items = append(items, RequestMetricSnapshot{
			Route: route, Requests: metric.Requests, Errors: metric.Errors, LastStatus: metric.LastStatus,
			LastDurationMS: metric.LastDuration.Milliseconds(), P95DurationMS: p95.Milliseconds(),
		})
	}
	sort.Slice(items, func(left, right int) bool {
		if items[left].Requests != items[right].Requests {
			return items[left].Requests > items[right].Requests
		}
		return items[left].Route < items[right].Route
	})
	return items
}

func (a *API) requestMetrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &metricsResponseWriter{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		statusCode := recorder.statusCode
		if statusCode == 0 {
			statusCode = http.StatusOK
		}
		a.metrics.record(normalizedRequestRoute(r), statusCode, time.Since(started))
	})
}

func normalizedRequestRoute(r *http.Request) string {
	pattern := strings.TrimSpace(r.Pattern)
	pattern = strings.TrimSpace(strings.TrimPrefix(pattern, r.Method+" "))
	if pattern == "" {
		pattern = "UNMATCHED"
	}
	return r.Method + " " + pattern
}

func (a *API) operationsOverview(w http.ResponseWriter, r *http.Request) {
	overview, err := a.collectOperationsOverview(r)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

func (a *API) collectOperationsOverview(r *http.Request) (OperationsOverview, error) {
	snapshot, err := a.store.GetOperationsSnapshot(r.Context())
	if err != nil {
		return OperationsOverview{}, err
	}
	jobKinds, err := a.store.GetBackgroundJobKindMetrics(r.Context())
	if err != nil {
		return OperationsOverview{}, err
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	generatedAt := time.Now().UTC()
	overview := OperationsOverview{
		GeneratedAt: generatedAt, UptimeSeconds: int64(time.Since(a.startedAt).Seconds()),
		GoRoutines: runtime.NumGoroutine(), HeapAllocBytes: memory.HeapAlloc, HeapSystemBytes: memory.HeapSys,
		Requests: a.metrics.snapshot(), Snapshot: snapshot, JobKinds: jobKinds,
	}
	overview.Disks = a.collectDiskMetrics()
	overview.Health = evaluateOperationsHealth(snapshot, overview.Disks, a.operationsConfig.Thresholds)
	if memory.LastGC != 0 {
		lastGC := time.Unix(0, int64(memory.LastGC)).UTC()
		overview.LastGCAt = &lastGC
	}
	return overview, nil
}

func (a *API) collectDiskMetrics() []OperationsDisk {
	items := make([]OperationsDisk, 0, len(a.operationsConfig.DiskRoots))
	for _, root := range a.operationsConfig.DiskRoots {
		item := OperationsDisk{Label: root.Label}
		usage, err := readDiskUsage(root.Path)
		if err != nil {
			a.logger.Warn("disk capacity check failed", "root", root.Label, "error", err)
			items = append(items, item)
			continue
		}
		item.Available = true
		item.TotalBytes = usage.TotalBytes
		item.AvailableBytes = usage.AvailableBytes
		if usage.TotalBytes > 0 {
			item.UsedPercent = float64(usage.TotalBytes-usage.AvailableBytes) / float64(usage.TotalBytes) * 100
		}
		items = append(items, item)
	}
	return items
}

func evaluateOperationsHealth(snapshot store.OperationsSnapshot, disks []OperationsDisk, thresholds OperationsThresholds) OperationsHealth {
	health := OperationsHealth{Status: "healthy", Issues: []OperationsHealthIssue{}, Thresholds: thresholds}
	addIssue := func(issue OperationsHealthIssue) {
		health.Issues = append(health.Issues, issue)
		if issue.Severity == "critical" || (issue.Severity == "warning" && health.Status == "healthy") {
			health.Status = issue.Severity
		}
	}
	for _, disk := range disks {
		if !disk.Available {
			addIssue(OperationsHealthIssue{Code: "disk_unavailable", Severity: "critical", Resource: disk.Label})
			continue
		}
		if disk.UsedPercent >= float64(thresholds.DiskCriticalPercent) {
			addIssue(OperationsHealthIssue{Code: "disk_usage", Severity: "critical", Resource: disk.Label, Value: disk.UsedPercent, Threshold: float64(thresholds.DiskCriticalPercent)})
		} else if disk.UsedPercent >= float64(thresholds.DiskWarningPercent) {
			addIssue(OperationsHealthIssue{Code: "disk_usage", Severity: "warning", Resource: disk.Label, Value: disk.UsedPercent, Threshold: float64(thresholds.DiskWarningPercent)})
		}
	}
	if snapshot.OldestQueuedSeconds >= thresholds.QueueCriticalSeconds {
		addIssue(OperationsHealthIssue{Code: "queue_wait", Severity: "critical", Resource: "background_jobs", Value: float64(snapshot.OldestQueuedSeconds), Threshold: float64(thresholds.QueueCriticalSeconds)})
	} else if snapshot.OldestQueuedSeconds >= thresholds.QueueWarningSeconds {
		addIssue(OperationsHealthIssue{Code: "queue_wait", Severity: "warning", Resource: "background_jobs", Value: float64(snapshot.OldestQueuedSeconds), Threshold: float64(thresholds.QueueWarningSeconds)})
	}
	if snapshot.FailedJobsLast24Hours >= thresholds.FailedJobsCritical {
		addIssue(OperationsHealthIssue{Code: "failed_jobs", Severity: "critical", Resource: "background_jobs", Value: float64(snapshot.FailedJobsLast24Hours), Threshold: float64(thresholds.FailedJobsCritical)})
	} else if snapshot.FailedJobsLast24Hours >= thresholds.FailedJobsWarning {
		addIssue(OperationsHealthIssue{Code: "failed_jobs", Severity: "warning", Resource: "background_jobs", Value: float64(snapshot.FailedJobsLast24Hours), Threshold: float64(thresholds.FailedJobsWarning)})
	}
	return health
}

func (a *API) prometheusMetrics(w http.ResponseWriter, r *http.Request) {
	if !a.operationsConfig.PrometheusEnabled {
		http.NotFound(w, r)
		return
	}
	presented := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(presented), []byte(a.operationsConfig.PrometheusBearerToken)) != 1 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="metrics"`)
		writeError(w, http.StatusUnauthorized, "metrics_unauthorized", "valid metrics bearer token required")
		return
	}
	overview, err := a.collectOperationsOverview(r)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "metrics_unavailable", "operations metrics are unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = w.Write([]byte(renderPrometheus(overview)))
}

func renderPrometheus(overview OperationsOverview) string {
	var output strings.Builder
	described := make(map[string]bool)
	metric := func(name, metricType, help, labels string, value float64) {
		if !described[name] {
			fmt.Fprintf(&output, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, metricType)
			described[name] = true
		}
		fmt.Fprintf(&output, "%s%s %s\n", name, labels, strconv.FormatFloat(value, 'f', -1, 64))
	}
	metric("peufmreader_uptime_seconds", "gauge", "Application uptime in seconds.", "", float64(overview.UptimeSeconds))
	metric("peufmreader_go_goroutines", "gauge", "Current goroutine count.", "", float64(overview.GoRoutines))
	metric("peufmreader_heap_alloc_bytes", "gauge", "Current allocated heap bytes.", "", float64(overview.HeapAllocBytes))
	metric("peufmreader_database_connections", "gauge", "Current database connections.", "", float64(overview.Snapshot.DatabaseConnections))
	metric("peufmreader_health_status", "gauge", "Health status: 0 healthy, 1 warning, 2 critical.", "", map[string]float64{"healthy": 0, "warning": 1, "critical": 2}[overview.Health.Status])
	for _, disk := range overview.Disks {
		labels := `{root="` + prometheusLabel(disk.Label) + `"}`
		available := 0.0
		if disk.Available {
			available = 1
		}
		metric("peufmreader_disk_available", "gauge", "Whether disk capacity information is available.", labels, available)
		metric("peufmreader_disk_total_bytes", "gauge", "Filesystem capacity in bytes.", labels, float64(disk.TotalBytes))
		metric("peufmreader_disk_available_bytes", "gauge", "Filesystem bytes available to the application.", labels, float64(disk.AvailableBytes))
		metric("peufmreader_disk_used_ratio", "gauge", "Filesystem used ratio from 0 to 1.", labels, disk.UsedPercent/100)
	}
	states := []struct {
		name  string
		value int
	}{{"queued", overview.Snapshot.QueuedJobs}, {"running", overview.Snapshot.RunningJobs}, {"failed", overview.Snapshot.FailedJobs}, {"retrying", overview.Snapshot.RetryingJobs}}
	for _, state := range states {
		metric("peufmreader_background_jobs", "gauge", "Current background jobs by state.", `{state="`+state.name+`"}`, float64(state.value))
	}
	metric("peufmreader_background_job_oldest_queued_seconds", "gauge", "Age of the oldest available queued job.", "", float64(overview.Snapshot.OldestQueuedSeconds))
	for _, item := range overview.JobKinds {
		kind := prometheusLabel(item.Kind)
		metric("peufmreader_background_job_finished_last_24h", "gauge", "Finished background jobs in the last 24 hours.", `{kind="`+kind+`",state="completed"}`, float64(item.CompletedLast24Hours))
		metric("peufmreader_background_job_finished_last_24h", "gauge", "Finished background jobs in the last 24 hours.", `{kind="`+kind+`",state="failed"}`, float64(item.FailedLast24Hours))
		metric("peufmreader_background_job_duration_average_seconds", "gauge", "Average end-to-end job duration in the last 24 hours.", `{kind="`+kind+`"}`, item.AverageDurationSeconds)
		metric("peufmreader_background_job_duration_p95_seconds", "gauge", "P95 end-to-end job duration in the last 24 hours.", `{kind="`+kind+`"}`, item.P95DurationSeconds)
	}
	for _, item := range overview.Requests {
		route := prometheusLabel(item.Route)
		metric("peufmreader_http_requests_total", "counter", "Requests observed since application start.", `{route="`+route+`"}`, float64(item.Requests))
		metric("peufmreader_http_request_errors_total", "counter", "HTTP error responses observed since application start.", `{route="`+route+`"}`, float64(item.Errors))
		metric("peufmreader_http_request_duration_p95_seconds", "gauge", "P95 request duration over recent in-memory samples.", `{route="`+route+`"}`, float64(item.P95DurationMS)/1000)
	}
	return output.String()
}

func prometheusLabel(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, "\n", `\n`)
	return strings.ReplaceAll(value, `"`, `\"`)
}
