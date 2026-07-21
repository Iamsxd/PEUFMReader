package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPublicSecurityRequiresAllowedHostAndTrustedHTTPSProxy(t *testing.T) {
	api := New(nil, nil, nil, nil, nil, nil, nil, nil, "", true, time.Hour, 1<<20, "172.18.0.0/16", slog.New(slog.NewTextHandler(io.Discard, nil)))
	api.ConfigurePublicSecurity(true, []string{"reader.example.com"})

	request := httptest.NewRequest(http.MethodGet, "http://reader.example.com/api/v1/auth/providers", nil)
	request.Host = "evil.example.com"
	request.RemoteAddr = "172.18.0.2:1234"
	request.Header.Set("X-Forwarded-Proto", "https")
	recorder := httptest.NewRecorder()
	api.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMisdirectedRequest {
		t.Fatalf("unexpected host status=%d", recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "http://reader.example.com/api/v1/auth/providers", nil)
	request.Host = "reader.example.com"
	request.RemoteAddr = "172.18.0.2:1234"
	recorder = httptest.NewRecorder()
	api.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUpgradeRequired {
		t.Fatalf("unconfirmed HTTPS status=%d", recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "http://reader.example.com/api/v1/auth/providers", nil)
	request.Host = "reader.example.com"
	request.RemoteAddr = "172.18.0.2:1234"
	request.Header.Set("X-Forwarded-Proto", "https")
	recorder = httptest.NewRecorder()
	api.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Strict-Transport-Security") == "" || recorder.Header().Get("Content-Security-Policy") == "" {
		t.Fatalf("secure response status=%d headers=%v", recorder.Code, recorder.Header())
	}
}
