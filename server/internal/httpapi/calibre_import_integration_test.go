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
	"testing"
	"time"

	"peufmreader/internal/calibre"
	"peufmreader/internal/httpapi"
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
