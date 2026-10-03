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

func TestPersonalWorkspacePrivacyFilteringAndOrdering(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	owner, err := dataStore.CreateUser(ctx, "workspace-owner", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = dataStore.CreateUser(ctx, "workspace-other", "Test-reader-password-123", "reader"); err != nil {
		t.Fatal(err)
	}
	var books [3]int64
	for index := range books {
		err = pool.QueryRow(ctx, `WITH nw AS (INSERT INTO works(title,sort_title) VALUES($1,$1) RETURNING id),
            ne AS(INSERT INTO editions(work_id) SELECT id FROM nw RETURNING id)
            INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
			SELECT id,'synthetic.pdf',$1 || '.pdf',decode($2,'hex'),'pdf','application/pdf',100 FROM ne RETURNING id`, fmt.Sprintf("Workspace Book %d", index), fmt.Sprintf("%064x", index+1)).Scan(&books[index])
		if err != nil {
			t.Fatal(err)
		}
	}
	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	first := login(t, server.URL, "workspace-owner", "Test-reader-password-123")
	second := login(t, server.URL, "workspace-other", "Test-reader-password-123")
	for index, book := range books {
		kind, color, quote := "note", "", ""
		if index == 1 {
			kind, color, quote = "highlight", "green", "A literal 100% quotation"
		}
		requestJSON(t, server.URL, first, http.MethodPost, fmt.Sprintf("/api/v1/book-files/%d/marks", book), map[string]any{
			"kind": kind, "color": color, "quote": quote, "position": map[string]any{"pageIndex": index}, "overallProgress": .2, "label": "Synthetic location", "body": fmt.Sprintf("Private thought %d", index),
		}, 201)
	}
	assertCount := func(path string, session testSession, want float64) map[string]any {
		t.Helper()
		result := requestJSON(t, server.URL, session, http.MethodGet, path, nil, 200)
		if result["total"] != want {
			t.Fatalf("%s total=%v want=%v", path, result["total"], want)
		}
		return result
	}
	page := assertCount("/api/v1/notebook?pageSize=1", first, 3)
	if len(page["items"].([]any)) != 1 || page["totalPages"] != float64(3) {
		t.Fatal("notebook is not paginated")
	}
	assertCount("/api/v1/notebook", second, 0)
	assertCount("/api/v1/notebook?kind=highlight&color=green", first, 1)
	assertCount("/api/v1/notebook?q=100%25", first, 1)
	assertCount("/api/v1/notebook?q=Workspace", first, 3)
	assertCount(fmt.Sprintf("/api/v1/notebook?bookId=%d", books[0]), first, 1)
	for _, query := range []string{"kind=unknown", "color=red", "page=0", "pageSize=101", "bookId=-1"} {
		requestJSON(t, server.URL, first, http.MethodGet, "/api/v1/notebook?"+query, nil, 400)
	}
	created := requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/shelves", map[string]any{"name": "My Queue", "description": "A private list"}, 201)
	shelfID := int64(created["id"].(float64))
	base := fmt.Sprintf("/api/v1/shelves/%d", shelfID)
	concurrent, _, err := dataStore.SavePersonalShelf(ctx, owner.ID, 0, "Concurrent", "test concurrent append")
	if err != nil {
		t.Fatal(err)
	}
	errorsFromWrites := make(chan error, len(books))
	for _, book := range books {
		go func(bookID int64) {
			found, err := dataStore.ChangePersonalShelfBook(ctx, owner.ID, concurrent.ID, bookID, "add")
			if err == nil && !found {
				err = fmt.Errorf("concurrent shelf disappeared")
			}
			errorsFromWrites <- err
		}(book)
	}
	for range books {
		if err := <-errorsFromWrites; err != nil {
			t.Fatal(err)
		}
	}
	var distinctPositions int
	if err := pool.QueryRow(ctx, `SELECT COUNT(DISTINCT position) FROM personal_shelf_books WHERE shelf_id=$1`, concurrent.ID).Scan(&distinctPositions); err != nil || distinctPositions != len(books) {
		t.Fatalf("concurrent append positions=%d err=%v", distinctPositions, err)
	}
	if _, err := dataStore.DeletePersonalShelf(ctx, owner.ID, concurrent.ID); err != nil {
		t.Fatal(err)
	}
	requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/shelves", map[string]any{"name": " my queue "}, 409)
	requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/shelves", map[string]any{"name": "  "}, 400)
	requestJSON(t, server.URL, second, http.MethodPost, "/api/v1/shelves", map[string]any{"name": "My Queue"}, 201)
	for _, book := range books {
		requestJSON(t, server.URL, first, http.MethodPut, fmt.Sprintf("%s/books/%d", base, book), nil, 204)
	}
	requestJSON(t, server.URL, first, http.MethodPut, fmt.Sprintf("%s/books/%d", base, books[0]), nil, 204)
	assertCount(base+"/books", first, 3)
	shelfPage := assertCount(base+"/books?page=2&pageSize=1", first, 3)
	if len(shelfPage["items"].([]any)) != 1 || shelfPage["items"].([]any)[0].(map[string]any)["id"] != float64(books[1]) {
		t.Fatal("shelf page order is incorrect")
	}
	for _, method := range []string{http.MethodGet, http.MethodDelete, http.MethodPatch} {
		path := base
		var input any
		if method == http.MethodGet {
			path += "/books"
		}
		if method == http.MethodPatch {
			input = map[string]any{"name": "Stolen"}
		}
		requestJSON(t, server.URL, second, method, path, input, 404)
	}
	requestJSON(t, server.URL, second, http.MethodPut, fmt.Sprintf("%s/books/%d", base, books[0]), nil, 404)
	missingCSRF := first
	missingCSRF.csrf = ""
	requestJSON(t, server.URL, missingCSRF, http.MethodPut, fmt.Sprintf("%s/books/%d", base, books[0]), nil, 403)
	requestJSON(t, server.URL, first, http.MethodPatch, fmt.Sprintf("%s/books/%d", base, books[1]), map[string]any{"direction": "earlier"}, 204)
	ordered := assertCount(base+"/books", first, 3)
	if ordered["items"].([]any)[0].(map[string]any)["id"] != float64(books[1]) {
		t.Fatal("reading order was not changed")
	}
	requestJSON(t, server.URL, first, http.MethodPatch, fmt.Sprintf("%s/books/%d", base, books[1]), map[string]any{"direction": "later"}, 204)
	requestJSON(t, server.URL, first, http.MethodPatch, fmt.Sprintf("%s/books/%d", base, books[1]), map[string]any{"direction": "invalid"}, 400)
	// Revoked books must disappear from marks, shelf counts, membership and pages.
	if _, err := dataStore.SetBookPermission(ctx, owner.ID, books[1], false); err != nil {
		t.Fatal(err)
	}
	assertCount("/api/v1/notebook", first, 2)
	assertCount(fmt.Sprintf("/api/v1/notebook?bookId=%d", books[1]), first, 0)
	assertCount(base+"/books", first, 2)
	shelves := requestJSON(t, server.URL, first, http.MethodGet, fmt.Sprintf("/api/v1/shelves?bookId=%d", books[1]), nil, 200)
	item := shelves["items"].([]any)[0].(map[string]any)
	if item["bookCount"] != float64(2) || item["containsBook"] != false {
		t.Fatal("shelf membership leaks revoked book")
	}
	requestJSON(t, server.URL, first, http.MethodPut, fmt.Sprintf("%s/books/%d", base, books[1]), nil, 404)
	requestJSON(t, server.URL, first, http.MethodDelete, fmt.Sprintf("%s/books/%d", base, books[1]), nil, 204)
	requestJSON(t, server.URL, first, http.MethodPatch, base, map[string]any{"name": "New Queue", "description": "Renamed"}, 200)
	requestJSON(t, server.URL, first, http.MethodDelete, base, nil, 204)
	var remainingBooks, remainingMarks, remainingMemberships int
	if err := pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM book_files),(SELECT COUNT(*) FROM reading_marks),(SELECT COUNT(*) FROM personal_shelf_books WHERE shelf_id=$1)`, shelfID).Scan(&remainingBooks, &remainingMarks, &remainingMemberships); err != nil {
		t.Fatal(err)
	}
	if remainingBooks != 3 || remainingMarks != 3 || remainingMemberships != 0 {
		t.Fatal("shelf deletion affected books or annotations")
	}
}
