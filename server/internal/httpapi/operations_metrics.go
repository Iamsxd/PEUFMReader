package httpapi

import (
	"net/http"
	"runtime"
	"sort"
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
	GeneratedAt     time.Time                `json:"generatedAt"`
	UptimeSeconds   int64                    `json:"uptimeSeconds"`
	GoRoutines      int                      `json:"goRoutines"`
	HeapAllocBytes  uint64                   `json:"heapAllocBytes"`
	HeapSystemBytes uint64                   `json:"heapSystemBytes"`
	LastGCAt        *time.Time               `json:"lastGcAt,omitempty"`
	Requests        []RequestMetricSnapshot  `json:"requests"`
	Snapshot        store.OperationsSnapshot `json:"snapshot"`
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
		route := r.Pattern
		if route == "" {
			route = r.URL.Path
		}
		a.metrics.record(r.Method+" "+route, statusCode, time.Since(started))
	})
}

func (a *API) operationsOverview(w http.ResponseWriter, r *http.Request) {
	snapshot, err := a.store.GetOperationsSnapshot(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	generatedAt := time.Now().UTC()
	overview := OperationsOverview{
		GeneratedAt: generatedAt, UptimeSeconds: int64(time.Since(a.startedAt).Seconds()),
		GoRoutines: runtime.NumGoroutine(), HeapAllocBytes: memory.HeapAlloc, HeapSystemBytes: memory.HeapSys,
		Requests: a.metrics.snapshot(), Snapshot: snapshot,
	}
	if memory.LastGC != 0 {
		lastGC := time.Unix(0, int64(memory.LastGC)).UTC()
		overview.LastGCAt = &lastGC
	}
	writeJSON(w, http.StatusOK, overview)
}
