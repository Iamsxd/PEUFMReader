package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSetFrontendCacheHeaders(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		expected string
	}{
		{name: "entry document", path: "index.html", expected: "no-cache"},
		{name: "manifest", path: "site.webmanifest", expected: "no-cache"},
		{name: "service worker", path: "sw.js", expected: "no-cache"},
		{name: "offline asset manifest", path: "offline-assets.json", expected: "no-cache"},
		{name: "fingerprinted asset", path: "assets/app-123.js", expected: "public, max-age=31536000, immutable"},
		{name: "site icon", path: "favicon.svg", expected: "public, max-age=86400"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			setFrontendCacheHeaders(recorder, tt.path)
			if actual := recorder.Header().Get("Cache-Control"); actual != tt.expected {
				t.Fatalf("Cache-Control = %q, want %q", actual, tt.expected)
			}
		})
	}
}

func TestAPIResponsesDisableSharedCaching(t *testing.T) {
	api := New(nil, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := httptest.NewRequest(http.MethodGet, "/api/v1/unknown", nil)
	recorder := httptest.NewRecorder()

	api.Handler().ServeHTTP(recorder, request)

	if actual := recorder.Header().Get("Cache-Control"); actual != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", actual)
	}
}
