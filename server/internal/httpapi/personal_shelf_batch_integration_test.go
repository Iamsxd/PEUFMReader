//go:build integration

package httpapi_test

import (
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

func assertShelfBookIDs(t *testing.T, response map[string]any, key string, want ...int64) {
	t.Helper()
	actual, ok := response[key].([]any)
	if !ok || len(actual) != len(want) {
		t.Fatalf("%s=%v, want=%v", key, response[key], want)
	}
	for index, id := range want {
		if actual[index] != float64(id) {
			t.Fatalf("%s=%v, want=%v", key, actual, want)
		}
	}
}

func TestPersonalShelfBatchPrivacyAtomicityAndValidation(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	owner, err := dataStore.CreateUser(ctx, "batch-owner", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dataStore.CreateUser(ctx, "batch-other", "Test-reader-password-123", "reader"); err != nil {
		t.Fatal(err)
	}
	var books [8]int64
	for index := range books {
		err = pool.QueryRow(ctx, `WITH nw AS (INSERT INTO works(title,sort_title) VALUES($1,$1) RETURNING id),
            ne AS (INSERT INTO editions(work_id) SELECT id FROM nw RETURNING id)
            INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
            SELECT id,'synthetic.pdf',$1 || '.pdf',decode($2,'hex'),'pdf','application/pdf',100 FROM ne RETURNING id`, fmt.Sprintf("Batch Synthetic Book %d", index), fmt.Sprintf("%064x", index+1)).Scan(&books[index])
		if err != nil {
			t.Fatal(err)
		}
	}
	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	first := login(t, server.URL, "batch-owner", "Test-reader-password-123")
	second := login(t, server.URL, "batch-other", "Test-reader-password-123")
	created := requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/shelves", map[string]any{"name": "Batch Queue"}, 201)
	shelfID := int64(created["id"].(float64))
	base := fmt.Sprintf("/api/v1/shelves/%d", shelfID)
	batch := func(session testSession, ids []int64, status int) map[string]any {
		t.Helper()
		return requestJSON(t, server.URL, session, http.MethodPost, base+"/books", map[string]any{"bookIds": ids}, status)
	}
	memberships := func(session testSession, ids string, status int) map[string]any {
		t.Helper()
		return requestJSON(t, server.URL, session, http.MethodGet, base+"/memberships?ids="+ids, nil, status)
	}
	assertShelfBookIDs(t, memberships(first, fmt.Sprint(books[0]), 200), "bookIds")
	result := batch(first, []int64{books[2], books[0], books[2], books[1]}, 200)
	assertShelfBookIDs(t, result, "addedBookIds", books[2], books[0], books[1])
	assertShelfBookIDs(t, result, "alreadyPresentBookIds")
	assertShelfBookIDs(t, memberships(first, fmt.Sprintf("%d,%d,%d,%d,%d", books[1], books[5], books[0], books[1], books[2]), 200), "bookIds", books[1], books[0], books[2])
	result = batch(first, []int64{books[1], books[4], books[3], books[4]}, 200)
	assertShelfBookIDs(t, result, "addedBookIds", books[4], books[3])
	assertShelfBookIDs(t, result, "alreadyPresentBookIds", books[1])
	page := requestJSON(t, server.URL, first, http.MethodGet, base+"/books", nil, 200)
	ordered := []int64{books[2], books[0], books[1], books[4], books[3]}
	if page["total"] != float64(len(ordered)) || len(page["items"].([]any)) != len(ordered) {
		t.Fatalf("unexpected shelf page=%v", page)
	}
	for index, book := range page["items"].([]any) {
		if book.(map[string]any)["id"] != float64(ordered[index]) {
			t.Fatalf("batch append order=%v, want=%v", page["items"], ordered)
		}
	}
	requestJSON(t, server.URL, first, http.MethodPut, fmt.Sprintf("%s/books/%d", base, books[4]), nil, 204)
	result = batch(first, ordered, 200)
	assertShelfBookIDs(t, result, "addedBookIds")
	assertShelfBookIDs(t, result, "alreadyPresentBookIds", ordered...)
	memberships(second, fmt.Sprint(books[0]), 404)
	batch(second, []int64{books[5]}, 404)
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		path := "/api/v1/shelves/9223372036854775807/books"
		var input any = map[string]any{"bookIds": []int64{books[5]}}
		if method == http.MethodGet {
			path = "/api/v1/shelves/9223372036854775807/memberships?ids=" + fmt.Sprint(books[0])
			input = nil
		}
		requestJSON(t, server.URL, first, method, path, input, 404)
	}
	missingCSRF := first
	missingCSRF.csrf = ""
	batch(missingCSRF, []int64{books[5]}, 403)
	if _, err := dataStore.SetBookPermission(ctx, owner.ID, books[0], false); err != nil {
		t.Fatal(err)
	}
	assertShelfBookIDs(t, memberships(first, fmt.Sprintf("%d,%d", books[0], books[1]), 200), "bookIds", books[1])
	batch(first, []int64{books[5], books[0]}, 404)
	batch(first, []int64{books[5], 9223372036854775807}, 404)
	var count, newBookCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*),COUNT(*) FILTER(WHERE book_file_id=$2) FROM personal_shelf_books WHERE shelf_id=$1`, shelfID, books[5]).Scan(&count, &newBookCount); err != nil || count != 5 || newBookCount != 0 {
		t.Fatalf("failed batch partially changed shelf: count=%d new=%d err=%v", count, newBookCount, err)
	}
	page = requestJSON(t, server.URL, first, http.MethodGet, base+"/books", nil, 200)
	if page["total"] != float64(4) {
		t.Fatal("shelf count exposed revoked book")
	}
	for _, query := range []string{"", "ids=", "ids=0", "ids=-1", "ids=no", "ids=1.2", "ids=9223372036854775808", "ids=1,", "ids=1,,2", "ids=1&ids=2", "ids=" + strings.Repeat("1,", 100) + "1"} {
		requestJSON(t, server.URL, first, http.MethodGet, base+"/memberships?"+query, nil, 400)
	}
	for _, input := range []any{
		map[string]any{}, map[string]any{"bookIds": nil}, map[string]any{"bookIds": []int64{}},
		map[string]any{"bookIds": []int64{1, 0}}, map[string]any{"bookIds": []int64{-1}},
		map[string]any{"bookIds": []any{1.5}}, map[string]any{"bookIds": []any{"1"}},
		map[string]any{"bookIds": []any{nil}}, map[string]any{"bookIds": "1"},
		map[string]any{"bookIds": []int64{books[1]}, "extra": true},
	} {
		requestJSON(t, server.URL, first, http.MethodPost, base+"/books", input, 400)
	}
	limit := make([]int64, 100)
	for index := range limit {
		limit[index] = books[1]
	}
	result = batch(first, limit, 200)
	assertShelfBookIDs(t, result, "addedBookIds")
	assertShelfBookIDs(t, result, "alreadyPresentBookIds", books[1])
	batch(first, append(limit, books[1]), 400)
	assertShelfBookIDs(t, memberships(first, strings.TrimSuffix(strings.Repeat(fmt.Sprint(books[1])+",", 100), ","), 200), "bookIds", books[1])
	if _, err := dataStore.SetBookPermission(ctx, owner.ID, books[0], true); err != nil {
		t.Fatal(err)
	}
	concurrent, _, err := dataStore.SavePersonalShelf(ctx, owner.ID, 0, "Concurrent Batch Queue", "")
	if err != nil {
		t.Fatal(err)
	}
	type writeResult struct {
		result store.PersonalShelfBatchResult
		found  bool
		err    error
	}
	writes := make(chan writeResult, 3)
	for _, ids := range [][]int64{{books[0], books[1], books[2]}, {books[2], books[3], books[4]}} {
		go func(ids []int64) {
			result, found, err := dataStore.AddPersonalShelfBooks(ctx, owner.ID, concurrent.ID, ids)
			writes <- writeResult{result: result, found: found, err: err}
		}(ids)
	}
	go func() {
		found, err := dataStore.ChangePersonalShelfBook(ctx, owner.ID, concurrent.ID, books[6], "add")
		writes <- writeResult{found: found, err: err}
	}()
	var results []store.PersonalShelfBatchResult
	for range 3 {
		write := <-writes
		if write.err != nil || !write.found {
			t.Fatalf("concurrent batch failed: found=%v err=%v", write.found, write.err)
		}
		results = append(results, write.result)
	}
	var distinctPositions, minPosition, maxPosition int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*),COUNT(DISTINCT position),MIN(position),MAX(position) FROM personal_shelf_books WHERE shelf_id=$1`, concurrent.ID).Scan(&count, &distinctPositions, &minPosition, &maxPosition); err != nil || count != 6 || distinctPositions != 6 || minPosition != 1 || maxPosition != 6 {
		t.Fatalf("concurrent positions: count=%d distinct=%d min=%d max=%d err=%v", count, distinctPositions, minPosition, maxPosition, err)
	}
	for _, result := range results {
		var previousPosition int
		for index, bookID := range result.AddedBookIDs {
			var position int
			if err := pool.QueryRow(ctx, `SELECT position FROM personal_shelf_books WHERE shelf_id=$1 AND book_file_id=$2`, concurrent.ID, bookID).Scan(&position); err != nil {
				t.Fatal(err)
			}
			if index > 0 && position != previousPosition+1 {
				t.Fatalf("batch append not contiguous/in order: added=%v previous=%d current=%d", result.AddedBookIDs, previousPosition, position)
			}
			previousPosition = position
		}
	}
}
