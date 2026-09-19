//go:build integration

package httpapi_test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"peufmreader/internal/database"
	"peufmreader/internal/httpapi"
	"peufmreader/internal/importing"
	"peufmreader/internal/library"
	"peufmreader/internal/metadata"
	"peufmreader/internal/store"
)

func TestUploadPreflightSkipsContentAndPreservesReports(t *testing.T) {
	pool := newIsolatedPool(t, t.Context())
	if err := database.Migrate(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	ds := store.New(pool)
	admin, err := ds.CreateUser(t.Context(), "preflight-admin", "Test-reader-password-123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ds.CreateUser(t.Context(), "preflight-reader", "Test-reader-password-123", "reader"); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	manager, err := library.NewManager(filepath.Join(root, "library"), filepath.Join(root, "staging"), filepath.Join(root, "cache"), 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	// Large enough to exercise net/http's disk-backed multipart cleanup too.
	content := []byte("%PDF-1.7\n" + strings.Repeat("x", 17<<20))
	stored, err := manager.Ingest("original.pdf", bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	job, err := ds.CreateImportJob(t.Context(), admin.ID, "seed", nil)
	if err != nil {
		t.Fatal(err)
	}
	book, _, err := ds.RegisterImportedBook(t.Context(), stored, metadata.Result{Title: "Original"}, nil, "", admin.ID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	api := httpapi.New(ds, manager, nil, importing.New(ds, manager, nil), nil, nil, nil, nil, "", false, time.Hour, 32<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	session := login(t, server.URL, "preflight-admin", "Test-reader-password-123")
	reader := login(t, server.URL, "preflight-reader", "Test-reader-password-123")
	requestJSON(t, server.URL, reader, "POST", "/api/v1/book-files/preflight", map[string]any{"sizes": []int64{stored.SizeBytes}}, http.StatusForbidden)
	noCSRF := session
	noCSRF.csrf = ""
	requestJSON(t, server.URL, noCSRF, "POST", "/api/v1/book-files/preflight", map[string]any{"sizes": []int64{stored.SizeBytes}}, http.StatusForbidden)
	requestJSON(t, server.URL, session, "POST", "/api/v1/book-files/preflight", map[string]any{"sizes": []int64{-1}}, http.StatusBadRequest)
	requestJSON(t, server.URL, session, "POST", "/api/v1/book-files/preflight", map[string]any{"unknown": 1}, http.StatusBadRequest)
	preflight := requestJSON(t, server.URL, session, "POST", "/api/v1/book-files/preflight", map[string]any{"sizes": []int64{stored.SizeBytes, 13}}, http.StatusOK)
	if sizes := preflight["matchingSizes"].([]any); len(sizes) != 1 || sizes[0] != float64(stored.SizeBytes) {
		t.Fatalf("unexpected sizes: %v", sizes)
	}
	batch := requestJSON(t, server.URL, session, "POST", "/api/v1/import-batches", map[string]any{"totalItems": 1}, http.StatusCreated)
	input := map[string]any{"sha256": hex.EncodeToString(stored.SHA256), "size": stored.SizeBytes, "filename": "renamed.pdf", "batchId": batch["id"], "itemKey": "0"}
	input["sha256"] = strings.Repeat("ab", 32)
	miss := requestJSON(t, server.URL, session, "POST", "/api/v1/book-files/skip-duplicate", input, http.StatusOK)
	if miss["duplicate"] != false {
		t.Fatal("different content was skipped")
	}
	input["sha256"] = stored.SHA256Hex
	first := requestJSON(t, server.URL, session, "POST", "/api/v1/book-files/skip-duplicate", input, http.StatusOK)
	second := requestJSON(t, server.URL, session, "POST", "/api/v1/book-files/skip-duplicate", input, http.StatusOK)
	if first["duplicate"] != true || first["importJobId"] != second["importJobId"] {
		t.Fatalf("not an idempotent skip: %v / %v", first, second)
	}
	detail := requestJSON(t, server.URL, session, "GET", fmt.Sprintf("/api/v1/import-batches/%.0f", batch["id"]), nil, http.StatusOK)
	if len(detail["jobs"].([]any)) != 1 || detail["batch"].(map[string]any)["pendingCount"] != float64(0) {
		t.Fatalf("incorrect report: %v", detail)
	}
	// Legacy clients still upload: duplicate detection must precede PDF parsing,
	// preserve the existing book, and clean both temporary storage layers.
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "renamed.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/book-files", &body)
	req.AddCookie(session.cookie)
	req.Header.Set("X-CSRF-Token", session.csrf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var uploaded map[string]any
	err = json.NewDecoder(resp.Body).Decode(&uploaded)
	resp.Body.Close()
	if err != nil || resp.StatusCode != http.StatusOK || uploaded["duplicate"] != true {
		t.Fatalf("legacy duplicate failed: %v %v", uploaded, err)
	}
	for _, dir := range []string{tmp, filepath.Join(root, "staging")} {
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) != 0 {
			t.Fatalf("temporary files remain in %s: %v %v", dir, entries, err)
		}
	}
	preserved, err := os.ReadFile(stored.AbsolutePath)
	if err != nil || !bytes.Equal(preserved, content) {
		t.Fatal("existing book changed")
	}
	// Missing books should be eligible for a repair upload rather than skipped.
	if _, err := pool.Exec(t.Context(), "UPDATE book_files SET storage_path='missing/book.pdf' WHERE id=$1", book.ID); err != nil {
		t.Fatal(err)
	}
	missing := requestJSON(t, server.URL, session, "POST", "/api/v1/book-files/skip-duplicate", input, http.StatusOK)
	if missing["duplicate"] != false {
		t.Fatal("missing file blocked upload")
	}
	if _, err := pool.Exec(t.Context(), "UPDATE book_files SET storage_mode='calibre-reference', reference_key='test', reference_path='book.pdf' WHERE id=$1", book.ID); err != nil {
		t.Fatal(err)
	}
	refs := requestJSON(t, server.URL, session, "POST", "/api/v1/book-files/preflight", map[string]any{"sizes": []int64{stored.SizeBytes}}, http.StatusOK)
	if len(refs["matchingSizes"].([]any)) != 0 {
		t.Fatal("reference fingerprint treated as content hash")
	}
}

func TestConcurrentRegistrationKeepsOneBook(t *testing.T) {
	pool := newIsolatedPool(t, t.Context())
	ds := store.New(pool)
	user, err := ds.CreateUser(t.Context(), "concurrent-admin", "Test-reader-password-123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	manager, err := library.NewManager(filepath.Join(root, "library"), filepath.Join(root, "staging"), filepath.Join(root, "cache"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := manager.Ingest("same.pdf", strings.NewReader("%PDF-1.7\nsame content"))
	if err != nil {
		t.Fatal(err)
	}
	jobs := make([]int64, 8)
	for i := range jobs {
		job, err := ds.CreateImportJob(t.Context(), user.ID, "concurrent", nil)
		if err != nil {
			t.Fatal(err)
		}
		jobs[i] = job.ID
	}
	var wg sync.WaitGroup
	for _, jobID := range jobs {
		wg.Go(func() {
			_, _, err := ds.RegisterImportedBook(t.Context(), stored, metadata.Result{Title: "Concurrent"}, nil, "", user.ID, jobID)
			if err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	var books, duplicates int
	if err := pool.QueryRow(t.Context(), "SELECT count(*) FROM book_files").Scan(&books); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), "SELECT count(*) FROM import_jobs WHERE outcome='duplicate'").Scan(&duplicates); err != nil {
		t.Fatal(err)
	}
	if books != 1 || duplicates != 7 {
		t.Fatalf("books=%d duplicates=%d", books, duplicates)
	}
}
