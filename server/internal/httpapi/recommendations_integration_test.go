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

	"peufmreader/internal/httpapi"
	"peufmreader/internal/store"
)

func TestRecommendationFeedbackImmediatelyChangesPersonalizedResults(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	if _, err := dataStore.CreateUser(ctx, "recommend-reader", "Test-reader-password-123", "reader"); err != nil {
		t.Fatal(err)
	}
	bookIDs := make([]int64, 0, 2)
	for index, title := range []string{"推荐候选甲", "推荐候选乙"} {
		var bookID int64
		if err := pool.QueryRow(ctx, `
			WITH new_work AS (INSERT INTO works(title,sort_title) VALUES ($1,$2) RETURNING id),
			new_edition AS (INSERT INTO editions(work_id) SELECT id FROM new_work RETURNING id)
			INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
			SELECT id,$3,$4,decode(repeat($5,32),'hex'),'epub','application/epub+zip',100 FROM new_edition
			RETURNING id`, title, title, fmt.Sprintf("book-%d.epub", index), fmt.Sprintf("test/book-%d.epub", index), fmt.Sprintf("%02x", index+1)).Scan(&bookID); err != nil {
			t.Fatal(err)
		}
		bookIDs = append(bookIDs, bookID)
	}

	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	session := login(t, server.URL, "recommend-reader", "Test-reader-password-123")

	requestJSON(t, server.URL, session, http.MethodPut, fmt.Sprintf("/api/v1/book-files/%d/recommendation-feedback", bookIDs[0]), map[string]any{
		"feedback": "not_interested",
	}, http.StatusOK)
	requestJSON(t, server.URL, session, http.MethodPut, fmt.Sprintf("/api/v1/book-files/%d/recommendation-feedback", bookIDs[1]), map[string]any{
		"feedback": "interested",
	}, http.StatusOK)

	result := requestJSON(t, server.URL, session, http.MethodGet, "/api/v1/recommendations?limit=24", nil, http.StatusOK)
	items := result["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("recommendation count=%d, want dismissed book excluded", len(items))
	}
	item := items[0].(map[string]any)
	book := item["book"].(map[string]any)
	if int64(book["id"].(float64)) != bookIDs[1] || item["feedback"] != "interested" {
		t.Fatalf("interested feedback was not reflected: %#v", item)
	}
}

