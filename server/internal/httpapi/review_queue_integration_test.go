//go:build integration

package httpapi_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"peufmreader/internal/httpapi"
	"peufmreader/internal/store"
)

func TestReviewQueuePages3336BooksWithoutReturningEvidence(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	if _, err := dataStore.CreateUser(ctx, "review-admin", "Test-review-password-123", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		DO $$
		DECLARE
			i integer;
			work_id bigint;
			edition_id bigint;
		BEGIN
			FOR i IN 1..3336 LOOP
				INSERT INTO works(title,sort_title) VALUES ('Review book ' || i, lpad(i::text, 4, '0')) RETURNING id INTO work_id;
				INSERT INTO editions(work_id) VALUES (work_id) RETURNING id INTO edition_id;
				INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
				VALUES (
					edition_id,
					'Review book ' || i || CASE WHEN i % 2 = 0 THEN '.pdf' ELSE '.epub' END,
					'review/' || i,
					decode(md5(i::text) || md5('review-' || i::text),'hex'),
					CASE WHEN i % 2 = 0 THEN 'pdf' ELSE 'epub' END,
					CASE WHEN i % 2 = 0 THEN 'application/pdf' ELSE 'application/epub+zip' END,
					100
				);
			END LOOP;
		END $$;
		INSERT INTO metadata_candidates(edition_id,field_name,value,source,confidence,reason,status)
		SELECT e.id,'field-' || evidence.number,to_jsonb(w.title),'regression',0.5,'large queue regression','suggested'
		FROM editions e JOIN works w ON w.id=e.work_id CROSS JOIN generate_series(1,5) evidence(number)`); err != nil {
		t.Fatal(err)
	}

	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	session := login(t, server.URL, "review-admin", "Test-review-password-123")

	result := requestJSON(t, server.URL, session, http.MethodGet, "/api/v1/review-queue", nil, http.StatusOK)
	if total := int(result["total"].(float64)); total != 3336 {
		t.Fatalf("review total=%d want=3336", total)
	}
	if pages := int(result["totalPages"].(float64)); pages != 167 {
		t.Fatalf("review totalPages=%d want=167", pages)
	}
	items := result["items"].([]any)
	if len(items) != 20 {
		t.Fatalf("review page items=%d want=20", len(items))
	}
	first := items[0].(map[string]any)
	if _, present := first["candidates"]; present {
		t.Fatal("review queue summary leaked full metadata evidence")
	}
	if count := int(first["candidateCount"].(float64)); count != 5 {
		t.Fatalf("candidateCount=%d want=5", count)
	}

	filtered := requestJSON(t, server.URL, session, http.MethodGet, "/api/v1/review-queue?format=pdf&pageSize=20", nil, http.StatusOK)
	if total := int(filtered["total"].(float64)); total != 1668 {
		t.Fatalf("filtered review total=%d want=1668", total)
	}
	count := requestJSON(t, server.URL, session, http.MethodGet, "/api/v1/review-queue/count", nil, http.StatusOK)
	if total := int(count["total"].(float64)); total != 3336 {
		t.Fatalf("review count=%d want=3336", total)
	}
}
