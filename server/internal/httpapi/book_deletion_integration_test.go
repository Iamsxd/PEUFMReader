//go:build integration

package httpapi_test

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"peufmreader/internal/httpapi"
	"peufmreader/internal/library"
	"peufmreader/internal/store"
)

func TestDeleteBookRespectsManagedAndReferenceStorage(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	if _, err := dataStore.CreateUser(ctx, "delete-admin", "Test-reader-password-123", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := dataStore.CreateUser(ctx, "delete-reader", "Test-reader-password-123", "reader"); err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	manager, err := library.NewManager(filepath.Join(root, "library"), filepath.Join(root, "staging"), filepath.Join(root, "cache"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	managedID := insertDeletionBook(t, pool, "managed", "aa/managed.pdf", nil, nil)
	managedPath := filepath.Join(root, "library", "aa", "managed.pdf")
	if err := os.MkdirAll(filepath.Dir(managedPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(managedPath, []byte("managed ebook"), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO reading_states(user_id,book_file_id,position) SELECT id,$1,'{}'::jsonb FROM users WHERE username='delete-reader'", managedID); err != nil {
		t.Fatal(err)
	}

	externalPath := filepath.Join(root, "calibre", "reference.epub")
	if err := os.MkdirAll(filepath.Dir(externalPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(externalPath, []byte("external ebook"), 0o640); err != nil {
		t.Fatal(err)
	}
	referenceID := insertDeletionBook(t, pool, "calibre-reference", "calibre-reference/item", &externalPath, pointer("calibre:test-reference"))

	api := httpapi.New(dataStore, manager, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	admin := login(t, server.URL, "delete-admin", "Test-reader-password-123")
	reader := login(t, server.URL, "delete-reader", "Test-reader-password-123")

	requestJSON(t, server.URL, reader, http.MethodDelete, fmt.Sprintf("/api/v1/book-files/%d", managedID), nil, http.StatusForbidden)
	managedResult := requestJSON(t, server.URL, admin, http.MethodDelete, fmt.Sprintf("/api/v1/book-files/%d", managedID), nil, http.StatusOK)
	if managedResult["fileAction"] != "deleted_managed_copy" || managedResult["managedFileFound"] != true || managedResult["externalSourceRetained"] != true {
		t.Fatalf("managed delete result=%+v", managedResult)
	}
	if _, err := os.Stat(managedPath); !os.IsNotExist(err) {
		t.Fatalf("managed ebook still exists err=%v", err)
	}
	assertDeletionBookGone(t, pool, managedID)

	referenceResult := requestJSON(t, server.URL, admin, http.MethodDelete, fmt.Sprintf("/api/v1/book-files/%d", referenceID), nil, http.StatusOK)
	if referenceResult["fileAction"] != "removed_catalog_reference" || referenceResult["managedFileFound"] != false || referenceResult["externalSourceRetained"] != true {
		t.Fatalf("reference delete result=%+v", referenceResult)
	}
	if content, err := os.ReadFile(externalPath); err != nil || string(content) != "external ebook" {
		t.Fatalf("external source changed content=%q err=%v", content, err)
	}
	assertDeletionBookGone(t, pool, referenceID)
}

func insertDeletionBook(t *testing.T, pool *pgxpool.Pool, storageMode, storagePath string, referencePath, referenceKey *string) int64 {
	t.Helper()
	ctx := t.Context()
	var workID, editionID, bookID int64
	if err := pool.QueryRow(ctx, `INSERT INTO works(title,sort_title) VALUES ($1,$1) RETURNING id`, "Book "+storagePath).Scan(&workID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "INSERT INTO editions(work_id) VALUES ($1) RETURNING id", workID).Scan(&editionID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO book_files(edition_id,original_filename,storage_path,storage_mode,reference_path,reference_key,sha256,format,mime_type,size_bytes)
		VALUES ($1,'book.pdf',$2,$3,$4,$5,decode(repeat($6,32),'hex'),'pdf','application/pdf',100) RETURNING id`,
		editionID, storagePath, storageMode, referencePath, referenceKey, fmt.Sprintf("%02x", editionID),
	).Scan(&bookID); err != nil {
		t.Fatal(err)
	}
	return bookID
}

func assertDeletionBookGone(t *testing.T, pool *pgxpool.Pool, bookID int64) {
	t.Helper()
	var remaining int
	if err := pool.QueryRow(t.Context(), "SELECT count(*) FROM book_files WHERE id=$1", bookID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("remaining book records=%d err=%v", remaining, err)
	}
}

func pointer(value string) *string {
	return &value
}
