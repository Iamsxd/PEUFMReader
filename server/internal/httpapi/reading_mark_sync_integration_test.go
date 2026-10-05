//go:build integration

package httpapi_test

import (
	"fmt"
	"github.com/google/uuid"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"peufmreader/internal/httpapi"
	"peufmreader/internal/store"
	"testing"
	"time"
)

func TestReadingMarkSyncReceiptsVersionsAndPrivacy(t *testing.T) {
	pool := newIsolatedPool(t, t.Context())
	s := store.New(pool)
	owner, err := s.CreateUser(t.Context(), "sync-owner", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateUser(t.Context(), "sync-other", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	var bookID int64
	err = pool.QueryRow(t.Context(), `WITH nw AS (INSERT INTO works(title,sort_title) VALUES ('Original sync test','original sync test') RETURNING id), ne AS (INSERT INTO editions(work_id) SELECT id FROM nw RETURNING id)
		INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
		SELECT id,'synthetic.pdf','sync-test.pdf',decode(repeat('ca',32),'hex'),'pdf','application/pdf',100 FROM ne RETURNING id`).Scan(&bookID)
	if err != nil {
		t.Fatal(err)
	}
	api := httpapi.New(s, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	first := login(t, server.URL, "sync-owner", "Test-reader-password-123")
	second := login(t, server.URL, "sync-other", "Test-reader-password-123")
	input := map[string]any{"accountId": owner.ID, "operationId": uuid.NewString(), "action": "create", "bookFileId": bookID, "markId": 0, "mark": map[string]any{"kind": "note", "position": map[string]any{"pageIndex": 0}, "overallProgress": 0.1, "label": "第 1 页", "body": "原创离线笔记"}}
	requestJSON(t, server.URL, second, http.MethodPost, "/api/v1/reading-marks/sync", input, 401)
	created := requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/reading-marks/sync", input, 200)["mark"].(map[string]any)
	retry := requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/reading-marks/sync", input, 200)["mark"].(map[string]any)
	if created["id"] != retry["id"] {
		t.Fatal("retry duplicated a mark")
	}
	markID := int64(created["id"].(float64))
	input["mark"].(map[string]any)["body"] = "ID reuse"
	requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/reading-marks/sync", input, 409)
	update := map[string]any{"accountId": other.ID, "operationId": uuid.NewString(), "action": "update", "bookFileId": bookID, "markId": markID, "expectedUpdatedAt": created["updatedAt"], "mark": map[string]any{"kind": "note", "label": "第 1 页", "body": "离线修改"}}
	requestJSON(t, server.URL, second, http.MethodPost, "/api/v1/reading-marks/sync", update, 404)
	update["accountId"] = owner.ID
	updated := requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/reading-marks/sync", update, 200)["mark"].(map[string]any)
	requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/reading-marks/sync", update, 200)
	update["operationId"] = uuid.NewString()
	requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/reading-marks/sync", update, 409)
	deleted := map[string]any{"accountId": owner.ID, "operationId": uuid.NewString(), "action": "delete", "bookFileId": bookID, "markId": markID, "expectedUpdatedAt": updated["updatedAt"], "mark": map[string]any{}}
	requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/reading-marks/sync", deleted, 200)
	input["mark"].(map[string]any)["body"] = "原创离线笔记"
	tombstone := requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/reading-marks/sync", input, 200)
	if tombstone["deleted"] != true || tombstone["mark"] != nil {
		t.Fatal("deleted receipt retains note text")
	}
	requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/reading-marks/sync", deleted, 200)
	if _, err = s.SetBookPermission(t.Context(), owner.ID, bookID, false); err != nil {
		t.Fatal(err)
	}
	requestJSON(t, server.URL, first, http.MethodPost, "/api/v1/reading-marks/sync", deleted, 404)
	var count int
	if err = pool.QueryRow(t.Context(), fmt.Sprintf("SELECT count(*) FROM reading_marks WHERE book_file_id=%d", bookID)).Scan(&count); err != nil || count != 0 {
		t.Fatalf("remaining marks: %d %v", count, err)
	}
}
