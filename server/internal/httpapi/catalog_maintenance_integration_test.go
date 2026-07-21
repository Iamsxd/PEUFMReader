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

	"peufmreader/internal/classification"
	"peufmreader/internal/httpapi"
	"peufmreader/internal/store"
)

func TestCatalogMaintenanceIsTransactionalAndAdminOnly(t *testing.T) {
	ctx := t.Context()
	pool := newIsolatedPool(t, ctx)
	dataStore := store.New(pool)
	if err := dataStore.EnsureClassificationRules(ctx, classification.DefaultRules()); err != nil {
		t.Fatal(err)
	}
	if _, err := dataStore.CreateUser(ctx, "catalog-admin", "Test-reader-password-123", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := dataStore.CreateUser(ctx, "catalog-reader", "Test-reader-password-123", "reader"); err != nil {
		t.Fatal(err)
	}
	workIDs := make([]int64, 4)
	editionIDs := make([]int64, 4)
	for index := range workIDs {
		if err := pool.QueryRow(ctx, `INSERT INTO works(title,sort_title) VALUES ($1,$2) RETURNING id`,
			fmt.Sprintf("Duplicate Book %d", index%2), fmt.Sprintf("duplicate book %d", index%2)).Scan(&workIDs[index]); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `INSERT INTO editions(work_id,isbn) VALUES ($1,$2) RETURNING id`,
			workIDs[index], fmt.Sprintf("isbn-%d", index%2)).Scan(&editionIDs[index]); err != nil {
			t.Fatal(err)
		}
		if index < 2 {
			if _, err := pool.Exec(ctx, `INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
				VALUES ($1,$2,$3,decode(repeat($4,32),'hex'),'pdf','application/pdf',100)`,
				editionIDs[index], fmt.Sprintf("test-%d.pdf", index), fmt.Sprintf("test/test-%d.pdf", index), fmt.Sprintf("%02x", index+1)); err != nil {
				t.Fatal(err)
			}
		}
	}

	api := httpapi.New(dataStore, nil, nil, nil, nil, nil, nil, nil, "", false, time.Hour, 1<<20, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(api.Handler())
	t.Cleanup(server.Close)
	admin := login(t, server.URL, "catalog-admin", "Test-reader-password-123")
	reader := login(t, server.URL, "catalog-reader", "Test-reader-password-123")

	requestJSON(t, server.URL, reader, http.MethodPatch, "/api/v1/admin/metadata/batch", map[string]any{
		"editionIds": []int64{editionIDs[0]}, "publisher": "Denied",
	}, http.StatusForbidden)
	requestJSON(t, server.URL, admin, http.MethodPatch, "/api/v1/admin/metadata/batch", map[string]any{
		"editionIds": []int64{editionIDs[0], editionIDs[1]}, "publisher": "Batch Publisher", "language": "zh-CN",
		"categoryMode": "replace", "categorySlugs": []string{"literature"},
	}, http.StatusOK)
	var updated int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM editions WHERE id=ANY($1) AND publisher='Batch Publisher' AND language='zh-CN'`, editionIDs[:2]).Scan(&updated); err != nil || updated != 2 {
		t.Fatalf("batch metadata updated=%d err=%v", updated, err)
	}

	rules := requestJSON(t, server.URL, admin, http.MethodGet, "/api/v1/admin/classification-rules", nil, http.StatusOK)
	items := rules["items"].([]any)
	if len(items) < 10 {
		t.Fatalf("classification rules=%d, want defaults", len(items))
	}
	rule := items[0].(map[string]any)
	ruleID := int64(rule["id"].(float64))
	requestJSON(t, server.URL, admin, http.MethodPatch, fmt.Sprintf("/api/v1/admin/classification-rules/%d", ruleID), map[string]any{
		"keywords": []string{"custom keyword"}, "enabled": true, "priority": 5,
	}, http.StatusOK)

	requestJSON(t, server.URL, admin, http.MethodPost, "/api/v1/admin/catalog/merge-editions", map[string]any{
		"sourceId": editionIDs[1], "targetId": editionIDs[0],
	}, http.StatusOK)
	var targetFiles int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM book_files WHERE edition_id=$1", editionIDs[0]).Scan(&targetFiles); err != nil || targetFiles != 2 {
		t.Fatalf("merged edition files=%d err=%v", targetFiles, err)
	}
	requestJSON(t, server.URL, admin, http.MethodPost, "/api/v1/admin/catalog/merge-works", map[string]any{
		"sourceId": workIDs[3], "targetId": workIDs[2],
	}, http.StatusOK)
	var movedEditions int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM editions WHERE work_id=$1", workIDs[2]).Scan(&movedEditions); err != nil || movedEditions != 2 {
		t.Fatalf("merged work editions=%d err=%v", movedEditions, err)
	}
}
