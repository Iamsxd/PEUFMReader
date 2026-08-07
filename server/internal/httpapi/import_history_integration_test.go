//go:build integration

package httpapi_test

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"peufmreader/internal/httpapi"
	"peufmreader/internal/store"
)

func TestImportBatchHistoryKeepsOutcomesAndCanBeDeletedWithoutBooks(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	adminUser, err := dataStore.CreateUser(ctx, "history-admin", "Test-reader-password-123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	bookID := insertImportHistoryBook(t, pool)

	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	session := login(t, server.URL, "history-admin", "Test-reader-password-123")

	created := requestJSON(t, server.URL, session, http.MethodPost, "/api/v1/import-batches", map[string]any{"totalItems": 3}, http.StatusCreated)
	batchID := int64(created["id"].(float64))
	first, err := dataStore.CreateImportJob(ctx, adminUser.ID, "new.epub", &batchID)
	if err != nil {
		t.Fatal(err)
	}
	if err := dataStore.CompleteImportJob(ctx, first.ID, bookID, "imported", nil); err != nil {
		t.Fatal(err)
	}
	duplicate, err := dataStore.CreateImportJob(ctx, adminUser.ID, "copy.epub", &batchID)
	if err != nil {
		t.Fatal(err)
	}
	if err := dataStore.CompleteImportJob(ctx, duplicate.ID, bookID, "duplicate", []string{"重复，未导入"}); err != nil {
		t.Fatal(err)
	}
	failed, err := dataStore.CreateImportJob(ctx, adminUser.ID, "broken.pdf", &batchID)
	if err != nil {
		t.Fatal(err)
	}
	if err := dataStore.FailImportJob(ctx, failed.ID, fmt.Errorf("metadata extraction failed")); err != nil {
		t.Fatal(err)
	}

	page := requestJSON(t, server.URL, session, http.MethodGet, "/api/v1/import-batches", nil, http.StatusOK)
	items := page["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("batch count=%d want 1", len(items))
	}
	summary := items[0].(map[string]any)
	if summary["importedCount"] != float64(1) || summary["duplicateCount"] != float64(1) || summary["failedCount"] != float64(1) || summary["pendingCount"] != float64(0) {
		t.Fatalf("unexpected batch summary: %#v", summary)
	}

	detail := requestJSON(t, server.URL, session, http.MethodGet, fmt.Sprintf("/api/v1/import-batches/%d", batchID), nil, http.StatusOK)
	jobs := detail["jobs"].([]any)
	if len(jobs) != 3 {
		t.Fatalf("job count=%d want 3", len(jobs))
	}
	if jobs[1].(map[string]any)["outcome"] != "duplicate" || jobs[2].(map[string]any)["errorMessage"] != "metadata extraction failed" {
		t.Fatalf("history detail did not preserve duplicate/failed outcomes: %#v", jobs)
	}

	requestJSON(t, server.URL, session, http.MethodDelete, fmt.Sprintf("/api/v1/import-batches/%d", batchID), nil, http.StatusNoContent)
	var remainingJobs, remainingBooks int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM import_jobs WHERE batch_id=$1", batchID).Scan(&remainingJobs); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM book_files WHERE id=$1", bookID).Scan(&remainingBooks); err != nil {
		t.Fatal(err)
	}
	if remainingJobs != 0 || remainingBooks != 1 {
		t.Fatalf("delete report jobs=%d books=%d; jobs should go, books should remain", remainingJobs, remainingBooks)
	}
}

func insertImportHistoryBook(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	var bookID int64
	if err := pool.QueryRow(t.Context(), `
		WITH new_work AS (INSERT INTO works(title,sort_title) VALUES ('Import history book','import history book') RETURNING id),
		new_edition AS (INSERT INTO editions(work_id) SELECT id FROM new_work RETURNING id)
		INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
		SELECT id,'history.epub','history/history.epub',decode(repeat('ab',32),'hex'),'epub','application/epub+zip',100 FROM new_edition RETURNING id`).Scan(&bookID); err != nil {
		t.Fatal(err)
	}
	return bookID
}
