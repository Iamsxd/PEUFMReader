//go:build integration

package httpapi_test

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"peufmreader/internal/httpapi"
	"peufmreader/internal/store"
)

func fetchNotebookExport(t *testing.T, base string, session *testSession, query string, status int) ([]byte, http.Header) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, base+"/api/v1/notebook/export?"+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	if session != nil {
		request.AddCookie(session.cookie)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != status {
		t.Fatalf("export %s status=%d want=%d body=%s", query, response.StatusCode, status, body)
	}
	if response.Header.Get("Cache-Control") != "private, no-store" {
		t.Fatal("private export response may be cached")
	}
	if status != 200 && response.Header.Get("Content-Disposition") != "" {
		t.Fatal("failed export advertised a partial attachment")
	}
	return body, response.Header
}

func TestNotebookExportPrivacyFiltersCompletenessAndLimits(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	owner, err := dataStore.CreateUser(ctx, "export-owner", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	other, err := dataStore.CreateUser(ctx, "export-other", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	limited, err := dataStore.CreateUser(ctx, "export-limit", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	var books [3]int64
	for index := range books {
		err := pool.QueryRow(ctx, `WITH nw AS (INSERT INTO works(title,sort_title) VALUES($1,$1) RETURNING id), ne AS(INSERT INTO editions(work_id) SELECT id FROM nw RETURNING id)
            INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
            SELECT id,'synthetic.pdf','synthetic-' || $1,decode($2,'hex'),'pdf','application/pdf',100 FROM ne RETURNING id`, fmt.Sprintf("Original Export Book %d", index), fmt.Sprintf("%064x", index+1)).Scan(&books[index])
		if err != nil {
			t.Fatal(err)
		}
	}
	insertNotes := func(userID, bookID int64, count int, body string) {
		t.Helper()
		_, err := pool.Exec(ctx, `INSERT INTO reading_marks(user_id,book_file_id,kind,position,overall_progress,label,body)
            SELECT $1,$2,'note',jsonb_build_object('pageIndex',n),0.5,'Original location ' || n,$4 FROM generate_series(1,$3::int) n`, userID, bookID, count, body)
		if err != nil {
			t.Fatal(err)
		}
	}
	insertNotes(owner.ID, books[0], 27, "Original private thought")
	insertNotes(owner.ID, books[2], 1, "Revoked private note must never appear")
	insertNotes(other.ID, books[0], 1, "Other account note must never appear")
	_, err = dataStore.SaveReadingMark(ctx, owner.ID, books[1], "highlight", json.RawMessage(`{"cfi":"epubcfi(/6/2!/4/1:0)"}`), .2, "Original CFI location", "Original 100% thought", "Original 100% quote", "green")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dataStore.SetBookPermission(ctx, owner.ID, books[2], false); err != nil {
		t.Fatal(err)
	}
	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	first := login(t, server.URL, "export-owner", "Test-reader-password-123")
	second := login(t, server.URL, "export-other", "Test-reader-password-123")
	third := login(t, server.URL, "export-limit", "Test-reader-password-123")
	checkJSONCount := func(session *testSession, query string, want int) {
		t.Helper()
		body, headers := fetchNotebookExport(t, server.URL, session, "format=json&"+query, 200)
		var payload struct {
			Version     int
			GeneratedAt time.Time
			Items       []store.NotebookEntry
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Version != 1 || payload.GeneratedAt.IsZero() || len(payload.Items) != want {
			t.Fatalf("export count/version=%d/%d want=%d", len(payload.Items), payload.Version, want)
		}
		if headers.Get("Content-Disposition") != `attachment; filename="notebook.json"` || !strings.HasPrefix(headers.Get("Content-Type"), "application/json") {
			t.Fatal("unsafe attachment headers", headers)
		}
	}
	checkJSONCount(&first, "", 28)
	checkJSONCount(&first, fmt.Sprintf("bookId=%d", books[0]), 27)
	checkJSONCount(&first, "q=100%25&kind=highlight&color=green", 1)
	checkJSONCount(&first, fmt.Sprintf("bookId=%d", books[2]), 0)
	checkJSONCount(&second, "", 1)
	markdown, headers := fetchNotebookExport(t, server.URL, &first, "format=markdown", 200)
	if strings.Count(string(markdown), "- 记录 ID：") != 28 || strings.Contains(string(markdown), "Other account") || strings.Contains(string(markdown), "Revoked private") || headers.Get("Content-Disposition") != `attachment; filename="notebook.md"` {
		t.Fatal("Markdown incomplete or leaked inaccessible notes")
	}
	fetchNotebookExport(t, server.URL, nil, "format=json", 401)
	for _, query := range []string{"format=bad", "format=json&page=2", "format=json&pageSize=10", "format=json&kind=unknown", "format=json&color=red", "format=json&bookId=-1", "format=json&q=" + url.QueryEscape(strings.Repeat("笔", 201))} {
		fetchNotebookExport(t, server.URL, &first, query, 400)
	}
	insertNotes(limited.ID, books[0], 5000, "Original limit fixture")
	checkJSONCount(&third, "", 5000)
	insertNotes(limited.ID, books[0], 1, "Record beyond limit")
	for _, format := range []string{"json", "markdown"} {
		fetchNotebookExport(t, server.URL, &third, "format="+format, 413)
	}
	if _, err := pool.Exec(ctx, "DELETE FROM reading_marks WHERE user_id=$1", limited.ID); err != nil {
		t.Fatal(err)
	}
	// Raw data is below 16 MiB, but escaped serialized JSON/Markdown both exceed it.
	insertNotes(limited.ID, books[0], 2000, strings.Repeat("<", 5000))
	for _, format := range []string{"json", "markdown"} {
		fetchNotebookExport(t, server.URL, &third, "format="+format, 413)
	}
	if _, err := pool.Exec(ctx, "DELETE FROM reading_marks WHERE user_id=$1", limited.ID); err != nil {
		t.Fatal(err)
	}
	// UTF-8 bytes, not character count, bound retained raw data as well.
	insertNotes(limited.ID, books[0], 600, strings.Repeat("笔", 10000))
	fetchNotebookExport(t, server.URL, &third, "format=json", 413)
}
