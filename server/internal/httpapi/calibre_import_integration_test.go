//go:build integration

package httpapi_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"peufmreader/internal/calibre"
	"peufmreader/internal/httpapi"
	"peufmreader/internal/library"
	"peufmreader/internal/store"
)

func TestCalibreImportDoesNotRequeueUnchangedCompletedSource(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	admin, err := dataStore.CreateUser(ctx, "calibre-admin", "Test-reader-password-123", "admin")
	if err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	bookDirectory := filepath.Join(root, "Author", "Stable Book (1)")
	if err := os.MkdirAll(bookDirectory, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bookDirectory, "metadata.opf"), []byte(`<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Stable Book</dc:title></metadata></package>`), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bookDirectory, "stable.pdf"), []byte("%PDF-1.7\n"), 0o640); err != nil {
		t.Fatal(err)
	}

	api := httpapi.New(dataStore, nil, nil, nil, calibre.NewScanner(root), nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	session := login(t, server.URL, admin.Username, "Test-reader-password-123")

	input := map[string]any{"sourcePaths": []string{"Author/Stable Book (1)/stable.pdf"}}
	first := requestJSON(t, server.URL, session, http.MethodPost, "/api/v1/calibre/import", input, http.StatusAccepted)
	if first["queued"].(float64) != 1 || first["existing"].(float64) != 0 {
		t.Fatalf("first Calibre import response=%#v", first)
	}
	jobID := int64(first["jobIds"].([]any)[0].(float64))
	job, found, err := dataStore.ClaimBackgroundJob(ctx, "calibre-import-test", time.Minute)
	if err != nil || !found || job.ID != jobID {
		t.Fatalf("claim Calibre job=%#v found=%v err=%v", job, found, err)
	}
	if err := dataStore.CompleteBackgroundJob(ctx, job.ID, "calibre-import-test", json.RawMessage(`{"ok":true}`)); err != nil {
		t.Fatal(err)
	}

	repeated := requestJSON(t, server.URL, session, http.MethodPost, "/api/v1/calibre/import", input, http.StatusAccepted)
	if repeated["queued"].(float64) != 0 || repeated["existing"].(float64) != 1 {
		t.Fatalf("completed Calibre source was requeued: %#v", repeated)
	}
}

func TestCalibreReferenceSyncQueuesOneRecoverableJob(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	admin, err := dataStore.CreateUser(ctx, "calibre-reference-admin", "Test-reader-password-123", "admin")
	if err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	bookDirectory := filepath.Join(root, "Author", "Reference Book (1)")
	if err := os.MkdirAll(bookDirectory, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bookDirectory, "metadata.opf"), []byte(`<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Reference Book</dc:title></metadata></package>`), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bookDirectory, "reference.pdf"), []byte("%PDF-1.7\n"), 0o640); err != nil {
		t.Fatal(err)
	}

	api := httpapi.New(dataStore, nil, nil, nil, calibre.NewScanner(root), nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	session := login(t, server.URL, admin.Username, "Test-reader-password-123")

	first := requestJSON(t, server.URL, session, http.MethodPost, "/api/v1/calibre/references/sync", map[string]any{}, http.StatusAccepted)
	if first["created"] != true {
		t.Fatalf("reference sync response=%#v", first)
	}
	jobID := int64(first["job"].(map[string]any)["id"].(float64))
	job, found, err := dataStore.ClaimBackgroundJob(ctx, "calibre-reference-test", time.Minute)
	if err != nil || !found || job.ID != jobID || job.Kind != calibre.ReferenceSyncJobKind {
		t.Fatalf("claim reference job=%#v found=%v err=%v", job, found, err)
	}
	if err := dataStore.CompleteBackgroundJob(ctx, job.ID, "calibre-reference-test", json.RawMessage(`{"ok":true}`)); err != nil {
		t.Fatal(err)
	}

	repeated := requestJSON(t, server.URL, session, http.MethodPost, "/api/v1/calibre/references/sync", map[string]any{}, http.StatusAccepted)
	if repeated["created"] != true {
		t.Fatalf("completed reference sync should be runnable again: %#v", repeated)
	}
}

func TestCalibreReferenceSyncKeepsSourceAndStreamsIt(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	reader, err := dataStore.CreateUser(ctx, "calibre-reference-reader", "Test-reader-password-123", "reader")
	if err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	bookDirectory := filepath.Join(root, "Author", "Referenced Book (1)")
	if err := os.MkdirAll(bookDirectory, 0o750); err != nil {
		t.Fatal(err)
	}
	content := []byte("%PDF-1.7\nreferenced book\n")
	sourcePath := filepath.Join(bookDirectory, "referenced.pdf")
	if err := os.WriteFile(filepath.Join(bookDirectory, "metadata.opf"), []byte(`<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Referenced Book</dc:title><dc:creator>Reference Author</dc:creator><dc:subject>Must Not Become A Category</dc:subject></metadata></package>`), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourcePath, content, 0o640); err != nil {
		t.Fatal(err)
	}

	managedRoot := t.TempDir()
	manager, err := library.NewManager(filepath.Join(managedRoot, "library"), filepath.Join(managedRoot, "staging"), filepath.Join(managedRoot, "cache"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	scanner := calibre.NewScanner(root)
	result, err := calibre.ReferenceSyncHandler(scanner, dataStore, manager)(ctx, store.BackgroundJob{})
	if err != nil {
		t.Fatal(err)
	}
	books, err := dataStore.ListCatalogBooks(ctx)
	if err != nil || len(books) != 1 {
		t.Fatalf("referenced catalogue books=%#v err=%v sync=%#v", books, err, result)
	}
	book := books[0]
	if book.StorageMode != "calibre-reference" || book.ReferencePath != "Author/Referenced Book (1)/referenced.pdf" {
		t.Fatalf("unexpected reference book=%#v", book)
	}
	var sourceSubjects []string
	if err := pool.QueryRow(ctx, "SELECT source_subjects FROM editions WHERE id=$1", book.EditionID).Scan(&sourceSubjects); err != nil || len(sourceSubjects) != 0 {
		t.Fatalf("Calibre tags must not enter PEUFMReader categories: subjects=%#v err=%v", sourceSubjects, err)
	}
	if _, err := manager.Resolve(book.StoragePath); err != nil {
		t.Fatal(err)
	} else if _, err := os.Stat(filepath.Join(managedRoot, "library", filepath.FromSlash(book.StoragePath))); !os.IsNotExist(err) {
		t.Fatalf("reference sync copied an ebook into managed storage: %v", err)
	}
	if source, err := os.ReadFile(sourcePath); err != nil || string(source) != string(content) {
		t.Fatalf("reference source changed: %q err=%v", source, err)
	}

	api := httpapi.New(dataStore, manager, nil, nil, scanner, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	session := login(t, server.URL, reader.Username, "Test-reader-password-123")
	request, err := http.NewRequest(http.MethodGet, server.URL+"/api/v1/book-files/"+strconv.FormatInt(book.ID, 10)+"/content", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(session.cookie)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	served, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || string(served) != string(content) {
		t.Fatalf("referenced content status=%d body=%q", response.StatusCode, served)
	}
}
