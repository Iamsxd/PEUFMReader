//go:build integration

package httpapi_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"peufmreader/internal/httpapi"
	"peufmreader/internal/store"
)

func TestDeviceTokenOPDSAndProgressBridge(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	if _, err := dataStore.CreateUser(ctx, "device-reader", "Test-reader-password-123", "reader"); err != nil {
		t.Fatal(err)
	}
	var bookID int64
	if err := pool.QueryRow(ctx, `WITH new_work AS (INSERT INTO works(title,sort_title) VALUES ('Device Book','device book') RETURNING id),
		new_edition AS (INSERT INTO editions(work_id) SELECT id FROM new_work RETURNING id)
		INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
		SELECT id,'device.pdf','device/device.pdf',decode(repeat('cd',32),'hex'),'pdf','application/pdf',100 FROM new_edition RETURNING id`).Scan(&bookID); err != nil {
		t.Fatal(err)
	}
	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	session := login(t, server.URL, "device-reader", "Test-reader-password-123")
	created := requestJSON(t, server.URL, session, http.MethodPost, "/api/v1/device-tokens", map[string]any{"name": "KOReader", "expiresDays": 30}, http.StatusCreated)
	token := created["token"].(string)
	tokenID := int64(created["id"].(float64))

	opdsRequest, _ := http.NewRequest(http.MethodGet, server.URL+"/opds/v1.2/catalog", nil)
	opdsRequest.SetBasicAuth("device-reader", token)
	opdsResponse, err := http.DefaultClient.Do(opdsRequest)
	if err != nil {
		t.Fatal(err)
	}
	opdsBody, _ := io.ReadAll(opdsResponse.Body)
	opdsResponse.Body.Close()
	if opdsResponse.StatusCode != http.StatusOK || !strings.Contains(string(opdsBody), "Device Book") || !strings.Contains(string(opdsBody), fmt.Sprintf("/opds/books/%d/download", bookID)) {
		t.Fatalf("OPDS status=%d body=%s", opdsResponse.StatusCode, opdsBody)
	}

	deviceJSON(t, server.URL, token, http.MethodPut, "/api/koreader/syncs/progress", map[string]any{
		"document": fmt.Sprintf("peufm:%d", bookID), "progress": "page=42", "percentage": 0.42, "device": "KOReader", "device_id": "test-device",
	}, http.StatusOK)
	webState := requestJSON(t, server.URL, session, http.MethodGet, fmt.Sprintf("/api/v1/book-files/%d/progress", bookID), nil, http.StatusOK)
	if webState["overallProgress"].(float64) != 0.42 {
		t.Fatalf("web progress after KOReader sync = %#v", webState)
	}
	deviceJSON(t, server.URL, token, http.MethodPut, fmt.Sprintf("/api/kobo/v1/library/%d/state", bookID), map[string]any{
		"locator": "chapter-7", "percentage": 0.7, "device": "Kobo",
	}, http.StatusOK)
	webState = requestJSON(t, server.URL, session, http.MethodGet, fmt.Sprintf("/api/v1/book-files/%d/progress", bookID), nil, http.StatusOK)
	if webState["overallProgress"].(float64) != 0.7 {
		t.Fatalf("web progress after Kobo sync = %#v", webState)
	}

	requestJSON(t, server.URL, session, http.MethodDelete, fmt.Sprintf("/api/v1/device-tokens/%d", tokenID), nil, http.StatusNoContent)
	deviceJSON(t, server.URL, token, http.MethodGet, "/api/koreader/users/auth", nil, http.StatusUnauthorized)
}

func deviceJSON(t *testing.T, baseURL, token, method, path string, input any, wantStatus int) map[string]any {
	t.Helper()
	var body io.Reader
	if input != nil {
		encoded, _ := json.Marshal(input)
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, baseURL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	content, _ := io.ReadAll(response.Body)
	if response.StatusCode != wantStatus {
		t.Fatalf("%s %s status=%d want=%d body=%s", method, path, response.StatusCode, wantStatus, content)
	}
	if len(content) == 0 {
		return map[string]any{}
	}
	var payload map[string]any
	if err := json.Unmarshal(content, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}
