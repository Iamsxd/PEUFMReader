//go:build integration

package httpapi_test

import (
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"

	"peufmreader/internal/httpapi"
	"peufmreader/internal/store"
)

func TestFullTextAndSmartShelvesRespectLivePermissions(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	s := store.New(pool)
	owner, err := s.CreateUser(ctx, "knowledge-owner", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateUser(ctx, "knowledge-other", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateUser(ctx, "knowledge-admin", "Test-reader-password-123", "admin"); err != nil {
		t.Fatal(err)
	}
	var books [2]store.BookFile
	for index := range books {
		var id int64
		err = pool.QueryRow(ctx, `WITH nw AS(INSERT INTO works(title,sort_title) VALUES($1,$1) RETURNING id),ne AS(INSERT INTO editions(work_id) SELECT id FROM nw RETURNING id)
            INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
            SELECT id,'synthetic.epub',$1,decode($2,'hex'),'epub','application/epub+zip',100 FROM ne RETURNING id`, fmt.Sprintf("Original search %d", index), fmt.Sprintf("%064x", index+909)).Scan(&id)
		if err != nil {
			t.Fatal(err)
		}
		books[index], _, err = s.GetCatalogBook(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		err = s.ReplaceTextIndex(ctx, books[index], "原创 EPUB 章节", []store.SearchPassage{{Label: "原创章", Position: map[string]any{"href": "chapter.xhtml"}, Body: "原创星空知识片段 100%_ 原文"}})
		if err != nil {
			t.Fatal(err)
		}
	}
	api := httpapi.New(s, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	first := login(t, server.URL, "knowledge-owner", "Test-reader-password-123")
	second := login(t, server.URL, "knowledge-other", "Test-reader-password-123")
	admin := login(t, server.URL, "knowledge-admin", "Test-reader-password-123")
	count := func(session testSession, want int) {
		t.Helper()
		result := requestJSON(t, server.URL, session, "GET", "/api/v1/search/text?q=%E6%98%9F%E7%A9%BA", nil, 200)
		if len(result["items"].([]any)) != want {
			t.Fatalf("search %v", result)
		}
	}
	count(first, 2)
	count(second, 2)
	if _, err = s.SetBookPermission(ctx, owner.ID, books[1].ID, false); err != nil {
		t.Fatal(err)
	}
	count(first, 1)
	count(second, 2)
	requestJSON(t, server.URL, first, "GET", "/api/v1/search/text?q=x", nil, 400)
	literal := requestJSON(t, server.URL, first, "GET", "/api/v1/search/text?q=100%25_", nil, 200)
	if len(literal["items"].([]any)) != 1 {
		t.Fatal("wildcard was not escaped")
	}
	requestJSON(t, server.URL, first, "POST", "/api/v1/admin/search/index", nil, 403)
	queued := requestJSON(t, server.URL, admin, "POST", "/api/v1/admin/search/index", nil, 202)
	if queued["queued"] != float64(0) {
		t.Fatalf("unchanged books reindexed: %v", queued)
	}
	// Replacement is transactional; stale sources cannot hide fresh text.
	stale := books[0]
	stale.SHA256 = []byte("changed")
	if err = s.ReplaceTextIndex(ctx, stale, "stale", nil); err == nil {
		t.Fatal("accepted stale source")
	}
	count(first, 1)
	if err = s.ReplaceTextIndex(ctx, books[0], "fresh", []store.SearchPassage{{Label: "新章", Position: map[string]any{"href": "new.xhtml"}, Body: "原创森林片段"}}); err != nil {
		t.Fatal(err)
	}
	count(first, 0)
	rules := map[string]any{"format": "epub", "status": "unread", "favorite": false, "categorySlug": ""}
	shelf := requestJSON(t, server.URL, first, "POST", "/api/v1/shelves", map[string]any{"name": "自动未读", "description": "原创规则", "rules": rules}, 201)
	shelfID := int64(shelf["id"].(float64))
	shelfPath := fmt.Sprintf("/api/v1/shelves/%d", shelfID)
	checkShelf := func(want float64) {
		t.Helper()
		result := requestJSON(t, server.URL, first, "GET", shelfPath+"/books", nil, 200)
		if result["total"] != want {
			t.Fatalf("shelf %v", result)
		}
	}
	checkShelf(1)
	requestJSON(t, server.URL, second, "GET", shelfPath+"/books", nil, 404)
	requestJSON(t, server.URL, first, "PUT", fmt.Sprintf("%s/books/%d", shelfPath, books[0].ID), nil, 404)
	requestJSON(t, server.URL, first, "PATCH", shelfPath, map[string]any{"name": "转换成手动", "description": ""}, 404)
	requestJSON(t, server.URL, first, "PUT", fmt.Sprintf("/api/v1/book-files/%d/progress", books[0].ID), map[string]any{"position": map[string]any{}, "overallProgress": .2, "status": "reading"}, 200)
	checkShelf(0)
	rules["status"] = "reading"
	rules["favorite"] = true
	requestJSON(t, server.URL, first, "PATCH", shelfPath, map[string]any{"name": "自动阅读收藏", "rules": rules}, 200)
	checkShelf(0)
	requestJSON(t, server.URL, first, "PUT", fmt.Sprintf("/api/v1/book-files/%d/favorite", books[0].ID), nil, 200)
	checkShelf(1)
	if _, err = s.SetBookPermission(ctx, other.ID, books[0].ID, false); err != nil {
		t.Fatal(err)
	}
	stats := requestJSON(t, server.URL, second, "GET", "/api/v1/search/index", nil, 200)
	if stats["indexedBooks"] != float64(1) {
		t.Fatalf("stats leak: %v", stats)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM book_files WHERE id=$1`, books[0].ID); err != nil {
		t.Fatal(err)
	}
	var passageCount int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM search_passages WHERE book_file_id=$1`, books[0].ID).Scan(&passageCount); err != nil || passageCount != 0 {
		t.Fatal("index did not cascade")
	}
}
