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

func TestExplicitBookPermissionProtectsCatalogAndDirectAccess(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	admin, err := dataStore.CreateUser(ctx, "permission-admin", "Test-reader-password-123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	reader, err := dataStore.CreateUser(ctx, "permission-reader", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}
	var bookID int64
	if err := pool.QueryRow(ctx, `WITH new_work AS (INSERT INTO works(title,sort_title) VALUES ('Private Book','private book') RETURNING id),
		new_edition AS (INSERT INTO editions(work_id) SELECT id FROM new_work RETURNING id)
		INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
		SELECT id,'private.pdf','private/private.pdf',decode(repeat('ef',32),'hex'),'pdf','application/pdf',100 FROM new_edition RETURNING id`).Scan(&bookID); err != nil {
		t.Fatal(err)
	}
	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	adminSession := login(t, server.URL, admin.Username, "Test-reader-password-123")
	readerSession := login(t, server.URL, reader.Username, "Test-reader-password-123")

	visible := requestJSON(t, server.URL, readerSession, http.MethodGet, "/api/v1/book-files", nil, http.StatusOK)
	if visible["total"].(float64) != 1 {
		t.Fatalf("default catalog total=%v, want 1", visible["total"])
	}
	requestJSON(t, server.URL, adminSession, http.MethodPut,
		fmt.Sprintf("/api/v1/users/%d/book-permissions/%d", reader.ID, bookID), map[string]any{"canRead": false}, http.StatusOK)
	hidden := requestJSON(t, server.URL, readerSession, http.MethodGet, "/api/v1/book-files", nil, http.StatusOK)
	if hidden["total"].(float64) != 0 {
		t.Fatalf("denied catalog total=%v, want 0", hidden["total"])
	}
	requestJSON(t, server.URL, readerSession, http.MethodGet, fmt.Sprintf("/api/v1/book-files/%d", bookID), nil, http.StatusNotFound)
	requestJSON(t, server.URL, adminSession, http.MethodGet, fmt.Sprintf("/api/v1/book-files/%d", bookID), nil, http.StatusOK)

	requestJSON(t, server.URL, adminSession, http.MethodDelete,
		fmt.Sprintf("/api/v1/users/%d/book-permissions/%d", reader.ID, bookID), nil, http.StatusNoContent)
	restored := requestJSON(t, server.URL, readerSession, http.MethodGet, "/api/v1/book-files", nil, http.StatusOK)
	if restored["total"].(float64) != 1 {
		t.Fatalf("restored catalog total=%v, want 1", restored["total"])
	}
}

func TestExternalIdentityCannotClaimLocalUsername(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	if _, err := dataStore.CreateUser(ctx, "existing-user", "Test-reader-password-123", "reader"); err != nil {
		t.Fatal(err)
	}
	if _, err := dataStore.UpsertExternalUser(ctx, "oidc", "subject-1", "existing-user", "reader"); err != store.ErrExternalIdentityConflict {
		t.Fatalf("external identity conflict error=%v", err)
	}
	external, err := dataStore.UpsertExternalUser(ctx, "ldap", "uid=alice,dc=example,dc=com", "alice", "reader")
	if err != nil || external.AuthSource != "ldap" {
		t.Fatalf("external user=%#v error=%v", external, err)
	}
}
