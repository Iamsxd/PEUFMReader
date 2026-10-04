//go:build integration

package httpapi_test

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"peufmreader/internal/httpapi"
	"peufmreader/internal/store"
)

func TestPersonalShelfRelativeOrderKeepsHiddenMembersAndSerializesEdits(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	owner, err := dataStore.CreateUser(ctx, "reorder-owner", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dataStore.CreateUser(ctx, "reorder-other", "Test-reader-password-123", "reader"); err != nil {
		t.Fatal(err)
	}
	var books [8]int64
	for index := range books {
		err = pool.QueryRow(ctx, `WITH nw AS (INSERT INTO works(title,sort_title) VALUES($1,$1) RETURNING id),
            ne AS (INSERT INTO editions(work_id) SELECT id FROM nw RETURNING id)
            INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
            SELECT id,'synthetic.pdf',$1 || '.pdf',decode($2,'hex'),'pdf','application/pdf',100 FROM ne RETURNING id`, fmt.Sprintf("Reorder Original Fixture %d", index), fmt.Sprintf("%064x", index+1)).Scan(&books[index])
		if err != nil {
			t.Fatal(err)
		}
	}
	shelf, _, err := dataStore.SavePersonalShelf(ctx, owner.ID, 0, "Relative Queue", "")
	if err != nil {
		t.Fatal(err)
	}
	for index, position := range []int64{10, 20, 50, 100, 200, 400} {
		if _, err := pool.Exec(ctx, `INSERT INTO personal_shelf_books(shelf_id,book_file_id,position) VALUES($1,$2,$3)`, shelf.ID, books[index], position); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := dataStore.SetBookPermission(ctx, owner.ID, books[1], false); err != nil {
		t.Fatal(err)
	}
	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	first := login(t, server.URL, "reorder-owner", "Test-reader-password-123")
	second := login(t, server.URL, "reorder-other", "Test-reader-password-123")
	path := fmt.Sprintf("/api/v1/shelves/%d/order", shelf.ID)
	move := func(session testSession, book, target int64, placement string, status int) {
		t.Helper()
		requestJSON(t, server.URL, session, http.MethodPatch, path, map[string]any{"bookId": book, "targetBookId": target, "placement": placement}, status)
	}
	readOrder := func(shelfID int64) ([]int64, []int64) {
		t.Helper()
		var ids, positions []int64
		if err := pool.QueryRow(ctx, `SELECT array_agg(book_file_id ORDER BY position,book_file_id),array_agg(position ORDER BY position,book_file_id) FROM personal_shelf_books WHERE shelf_id=$1`, shelfID).Scan(&ids, &positions); err != nil {
			t.Fatal(err)
		}
		return ids, positions
	}
	assertOrder := func(want ...int64) {
		t.Helper()
		ids, positions := readOrder(shelf.ID)
		if !reflect.DeepEqual(ids, want) {
			t.Fatalf("order=%v want=%v", ids, want)
		}
		for index, position := range positions {
			if position != int64(index+1) {
				t.Fatalf("noncontiguous positions after move: %v", positions)
			}
		}
	}
	move(first, books[0], books[4], "after", 204)
	assertOrder(books[1], books[2], books[3], books[4], books[0], books[5])
	beforeIDs, beforePositions := readOrder(shelf.ID)
	move(first, books[0], books[4], "after", 204)
	afterIDs, afterPositions := readOrder(shelf.ID)
	if !reflect.DeepEqual(beforeIDs, afterIDs) || !reflect.DeepEqual(beforePositions, afterPositions) {
		t.Fatal("repeating a relative move is not idempotent")
	}
	move(first, books[5], books[2], "before", 204)
	assertOrder(books[1], books[5], books[2], books[3], books[4], books[0])
	// A visible page contains neither the hidden first member nor the whole list.
	page := requestJSON(t, server.URL, first, http.MethodGet, fmt.Sprintf("/api/v1/shelves/%d/books?page=2&pageSize=2", shelf.ID), nil, 200)
	if page["total"] != float64(5) || len(page["items"].([]any)) != 2 {
		t.Fatal("reorder changed access-filtered pagination")
	}
	move(second, books[5], books[2], "after", 404)
	noCSRF := first
	noCSRF.csrf = ""
	move(noCSRF, books[5], books[2], "after", 403)
	for _, pair := range [][2]int64{{books[1], books[2]}, {books[2], books[1]}, {books[6], books[2]}, {books[2], books[6]}, {9223372036854775807, books[2]}} {
		move(first, pair[0], pair[1], "before", 404)
	}
	requestJSON(t, server.URL, first, http.MethodPatch, "/api/v1/shelves/9223372036854775807/order", map[string]any{"bookId": books[0], "targetBookId": books[2], "placement": "before"}, 404)
	for _, input := range []any{
		map[string]any{},
		map[string]any{"bookId": 0, "targetBookId": books[2], "placement": "before"},
		map[string]any{"bookId": books[0], "targetBookId": -1, "placement": "after"},
		map[string]any{"bookId": books[2], "targetBookId": books[2], "placement": "before"},
		map[string]any{"bookId": books[0], "targetBookId": books[2], "placement": "earlier"},
		map[string]any{"bookId": "1", "targetBookId": books[2], "placement": "before"},
		map[string]any{"bookId": 1.5, "targetBookId": books[2], "placement": "before"},
		map[string]any{"bookId": books[0], "targetBookId": books[2], "placement": "before", "order": []int64{books[0]}},
	} {
		requestJSON(t, server.URL, first, http.MethodPatch, path, input, 400)
	}
	assertOrder(books[1], books[5], books[2], books[3], books[4], books[0])
	concurrent, _, err := dataStore.SavePersonalShelf(ctx, owner.ID, 0, "Concurrent Relative Queue", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, found, err := dataStore.AddPersonalShelfBooks(ctx, owner.ID, concurrent.ID, []int64{books[0], books[2], books[3], books[4]}); err != nil || !found {
		t.Fatalf("initial batch found=%v err=%v", found, err)
	}
	writes := make(chan error, 5)
	for range 3 {
		go func() {
			found, err := dataStore.ReorderPersonalShelfBook(ctx, owner.ID, concurrent.ID, books[2], books[4], "after")
			if err == nil && !found {
				err = fmt.Errorf("concurrent reorder missing shelf")
			}
			writes <- err
		}()
	}
	go func() {
		_, found, err := dataStore.AddPersonalShelfBooks(ctx, owner.ID, concurrent.ID, []int64{books[6], books[7]})
		if err == nil && !found {
			err = fmt.Errorf("concurrent append missing shelf")
		}
		writes <- err
	}()
	go func() {
		found, err := dataStore.ChangePersonalShelfBook(ctx, owner.ID, concurrent.ID, books[3], "earlier")
		if err == nil && !found {
			err = fmt.Errorf("concurrent arrow move missing shelf")
		}
		writes <- err
	}()
	for range 5 {
		if err := <-writes; err != nil {
			t.Fatal(err)
		}
	}
	ids, positions := readOrder(concurrent.ID)
	if len(ids) != 6 || ids[4] != books[6] || ids[5] != books[7] {
		t.Fatalf("concurrent move lost/appended members out of order: %v", ids)
	}
	for index, position := range positions {
		if position != int64(index+1) {
			t.Fatalf("concurrent edits produced duplicate/gapped positions: %v", positions)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM book_files`).Scan(&count); err != nil || count != len(books) {
		t.Fatalf("relative order modified book records: count=%d err=%v", count, err)
	}
}
