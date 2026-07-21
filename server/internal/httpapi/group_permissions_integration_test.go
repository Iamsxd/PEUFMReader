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

func TestLibraryAndUserGroupPermissionPrecedence(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	admin, err := dataStore.CreateUser(ctx, "group-admin", "Test-reader-password-123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	reader, err := dataStore.CreateUser(ctx, "group-reader", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	var bookID int64
	if err := pool.QueryRow(ctx, `WITH new_work AS (INSERT INTO works(title,sort_title) VALUES ('Restricted Book','restricted book') RETURNING id),
		new_edition AS (INSERT INTO editions(work_id) SELECT id FROM new_work RETURNING id)
		INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
		SELECT id,'restricted.pdf','restricted/restricted.pdf',decode(repeat('ab',32),'hex'),'pdf','application/pdf',100 FROM new_edition RETURNING id`).Scan(&bookID); err != nil {
		t.Fatal(err)
	}
	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	adminSession := login(t, server.URL, admin.Username, "Test-reader-password-123")
	readerSession := login(t, server.URL, reader.Username, "Test-reader-password-123")
	requestJSON(t, server.URL, readerSession, http.MethodPut, fmt.Sprintf("/api/v1/book-files/%d/favorite", bookID), nil, http.StatusOK)

	libraryGroup := requestJSON(t, server.URL, adminSession, http.MethodPost, "/api/v1/admin/library-groups", map[string]any{
		"name": "Private library", "description": "Members only", "defaultAccess": false,
	}, http.StatusCreated)
	libraryGroupID := int64(libraryGroup["id"].(float64))
	requestJSON(t, server.URL, adminSession, http.MethodPut,
		fmt.Sprintf("/api/v1/admin/library-groups/%d/books/%d", libraryGroupID, bookID), nil, http.StatusNoContent)
	assertCatalogTotal(t, server.URL, readerSession, 0)
	assertFavoriteTotal(t, server.URL, readerSession, 0)
	assertRecentlyAddedCount(t, server.URL, readerSession, 0)
	requestJSON(t, server.URL, readerSession, http.MethodGet, fmt.Sprintf("/api/v1/book-files/%d", bookID), nil, http.StatusNotFound)

	userGroup := requestJSON(t, server.URL, adminSession, http.MethodPost, "/api/v1/admin/user-groups", map[string]any{
		"name": "Family", "description": "Family readers",
	}, http.StatusCreated)
	userGroupID := int64(userGroup["id"].(float64))
	requestJSON(t, server.URL, adminSession, http.MethodPut,
		fmt.Sprintf("/api/v1/admin/user-groups/%d/members/%d", userGroupID, reader.ID), nil, http.StatusNoContent)
	requestJSON(t, server.URL, adminSession, http.MethodPut,
		fmt.Sprintf("/api/v1/admin/user-groups/%d/library-permissions/%d", userGroupID, libraryGroupID), map[string]any{"canRead": true}, http.StatusOK)
	assertCatalogTotal(t, server.URL, readerSession, 1)
	assertFavoriteTotal(t, server.URL, readerSession, 1)
	assertRecentlyAddedCount(t, server.URL, readerSession, 1)

	requestJSON(t, server.URL, adminSession, http.MethodPut,
		fmt.Sprintf("/api/v1/admin/user-groups/%d/library-permissions/%d", userGroupID, libraryGroupID), map[string]any{"canRead": false}, http.StatusOK)
	assertCatalogTotal(t, server.URL, readerSession, 0)

	requestJSON(t, server.URL, adminSession, http.MethodPut,
		fmt.Sprintf("/api/v1/users/%d/book-permissions/%d", reader.ID, bookID), map[string]any{"canRead": true}, http.StatusOK)
	assertCatalogTotal(t, server.URL, readerSession, 1)
	requestJSON(t, server.URL, readerSession, http.MethodGet, fmt.Sprintf("/api/v1/book-files/%d", bookID), nil, http.StatusOK)
}

func assertCatalogTotal(t *testing.T, baseURL string, session testSession, want float64) {
	t.Helper()
	result := requestJSON(t, baseURL, session, http.MethodGet, "/api/v1/book-files", nil, http.StatusOK)
	if result["total"].(float64) != want {
		t.Fatalf("catalog total=%v, want %v", result["total"], want)
	}
}

func assertFavoriteTotal(t *testing.T, baseURL string, session testSession, want float64) {
	t.Helper()
	result := requestJSON(t, baseURL, session, http.MethodGet, "/api/v1/favorites", nil, http.StatusOK)
	if result["total"].(float64) != want {
		t.Fatalf("favorite total=%v, want %v", result["total"], want)
	}
}

func assertRecentlyAddedCount(t *testing.T, baseURL string, session testSession, want int) {
	t.Helper()
	result := requestJSON(t, baseURL, session, http.MethodGet, "/api/v1/home", nil, http.StatusOK)
	if len(result["recentlyAdded"].([]any)) != want {
		t.Fatalf("recently added count=%d, want %d", len(result["recentlyAdded"].([]any)), want)
	}
}
