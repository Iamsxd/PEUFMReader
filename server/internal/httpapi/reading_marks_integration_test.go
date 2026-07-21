//go:build integration

package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"peufmreader/internal/database"
	"peufmreader/internal/httpapi"
	"peufmreader/internal/store"
)

type testSession struct {
	cookie *http.Cookie
	csrf   string
}

func TestReadingMarksArePrivateAndOwnerManaged(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	firstUser, err := dataStore.CreateUser(ctx, "mark-reader-a", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dataStore.CreateUser(ctx, "mark-reader-b", "Test-reader-password-123", "reader"); err != nil {
		t.Fatal(err)
	}
	var bookID int64
	if err := pool.QueryRow(ctx, `
		WITH new_work AS (INSERT INTO works(title,sort_title) VALUES ('Test Book','test book') RETURNING id),
		new_edition AS (INSERT INTO editions(work_id) SELECT id FROM new_work RETURNING id)
		INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
		SELECT id,'test.pdf','test/test.pdf',decode(repeat('ab',32),'hex'),'pdf','application/pdf',100 FROM new_edition
		RETURNING id`).Scan(&bookID); err != nil {
		t.Fatal(err)
	}

	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	first := login(t, server.URL, "mark-reader-a", "Test-reader-password-123")
	second := login(t, server.URL, "mark-reader-b", "Test-reader-password-123")

	created := requestJSON(t, server.URL, first, http.MethodPost, fmt.Sprintf("/api/v1/book-files/%d/marks", bookID), map[string]any{
		"kind": "note", "position": map[string]any{"pageIndex": 4, "yRatio": 0}, "overallProgress": 0.05,
		"label": "第 5 页", "body": "记住这一段",
	}, http.StatusCreated)
	markID := int64(created["id"].(float64))
	requestJSON(t, server.URL, first, http.MethodPost, fmt.Sprintf("/api/v1/book-files/%d/marks", bookID), map[string]any{
		"kind": "note", "position": map[string]any{"pageIndex": 4, "yRatio": 0}, "overallProgress": 0.05,
		"label": "第 5 页", "body": "同一位置的另一条笔记",
	}, http.StatusCreated)
	firstBookmark := requestJSON(t, server.URL, first, http.MethodPost, fmt.Sprintf("/api/v1/book-files/%d/marks", bookID), map[string]any{
		"kind": "bookmark", "position": map[string]any{"pageIndex": 4, "yRatio": 0}, "overallProgress": 0.05,
		"label": "第 5 页", "body": "",
	}, http.StatusCreated)
	secondBookmark := requestJSON(t, server.URL, first, http.MethodPost, fmt.Sprintf("/api/v1/book-files/%d/marks", bookID), map[string]any{
		"kind": "bookmark", "position": map[string]any{"pageIndex": 4, "yRatio": 0}, "overallProgress": 0.05,
		"label": "第 5 页", "body": "",
	}, http.StatusCreated)
	if firstBookmark["id"] != secondBookmark["id"] {
		t.Fatal("repeated bookmark at the same location was not de-duplicated")
	}

	firstList := requestJSON(t, server.URL, first, http.MethodGet, fmt.Sprintf("/api/v1/book-files/%d/marks", bookID), nil, http.StatusOK)
	if items := firstList["items"].([]any); len(items) != 3 {
		t.Fatalf("owner mark count=%d, want 2 notes and 1 de-duplicated bookmark", len(items))
	}
	secondList := requestJSON(t, server.URL, second, http.MethodGet, fmt.Sprintf("/api/v1/book-files/%d/marks", bookID), nil, http.StatusOK)
	if items := secondList["items"].([]any); len(items) != 0 {
		t.Fatalf("other user can see private marks: %#v", items)
	}
	requestJSON(t, server.URL, second, http.MethodPatch, fmt.Sprintf("/api/v1/reading-marks/%d", markID), map[string]any{
		"label": "changed", "body": "not allowed",
	}, http.StatusNotFound)
	requestJSON(t, server.URL, first, http.MethodPatch, fmt.Sprintf("/api/v1/reading-marks/%d", markID), map[string]any{
		"label": "重点", "body": "更新后的笔记",
	}, http.StatusOK)
	requestJSON(t, server.URL, first, http.MethodDelete, fmt.Sprintf("/api/v1/reading-marks/%d", markID), nil, http.StatusNoContent)

	if firstUser.ID == 0 {
		t.Fatal("created user has no ID")
	}
}

func newIsolatedPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	baseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if baseURL == "" {
		t.Skip("TEST_DATABASE_URL is required for integration tests")
	}
	admin, err := pgxpool.New(ctx, baseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("reading_marks_test_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+identifier+" CASCADE")
		admin.Close()
	})
	config, err := pgxpool.ParseConfig(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

func login(t *testing.T, baseURL, username, password string) testSession {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"username": username, "password": password})
	response, err := http.Post(baseURL+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		content, _ := io.ReadAll(response.Body)
		t.Fatalf("login status=%d body=%s", response.StatusCode, content)
	}
	var payload struct {
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	for _, cookie := range response.Cookies() {
		if cookie.Name == "peufm_session" {
			return testSession{cookie: cookie, csrf: payload.CSRFToken}
		}
	}
	t.Fatal("login did not set session cookie")
	return testSession{}
}

func requestJSON(t *testing.T, baseURL string, session testSession, method, path string, input any, wantStatus int) map[string]any {
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
	request.AddCookie(session.cookie)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet {
		request.Header.Set("X-CSRF-Token", session.csrf)
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
