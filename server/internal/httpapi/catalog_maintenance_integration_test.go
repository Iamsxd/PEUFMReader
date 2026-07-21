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
	updatedRule := requestJSON(t, server.URL, admin, http.MethodPatch, fmt.Sprintf("/api/v1/admin/classification-rules/%d", ruleID), map[string]any{
		"keywords": []string{"custom keyword"}, "strongKeywords": []string{"distinctive title"}, "enabled": true, "priority": 5,
	}, http.StatusOK)
	if updatedRule["customized"] != true || len(updatedRule["strongKeywords"].([]any)) != 1 {
		t.Fatalf("updated classification rule=%+v", updatedRule)
	}

	requestJSON(t, server.URL, reader, http.MethodPost, "/api/v1/admin/classification/reclassify", map[string]any{
		"scope": "unclassified",
	}, http.StatusForbidden)
	reclassification := requestJSON(t, server.URL, admin, http.MethodPost, "/api/v1/admin/classification/reclassify", map[string]any{
		"scope": "unclassified",
	}, http.StatusAccepted)
	if reclassification["created"] != true {
		t.Fatalf("reclassification response=%+v", reclassification)
	}

	if _, err := pool.Exec(ctx, `INSERT INTO classification_decisions(edition_id,category_id,source,confidence,reason,status)
		SELECT $1,id,'deterministic-rules-v2',0.91,'strong title','accepted' FROM categories WHERE slug='literature'`, editionIDs[2]); err != nil {
		t.Fatal(err)
	}
	changed, err := dataStore.ReplaceAutomaticClassification(ctx, editionIDs[2], []classification.Suggestion{{
		CategorySlug: "essays", Confidence: 0.82, Reason: "external title only",
		Source: "bibliography-rules-v2:test", Status: "suggested",
	}})
	if err != nil || changed {
		t.Fatalf("weaker automatic classification changed=%t err=%v", changed, err)
	}
	var acceptedAutomatic int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM classification_decisions
		WHERE edition_id=$1 AND source='deterministic-rules-v2' AND status='accepted'`, editionIDs[2]).Scan(&acceptedAutomatic); err != nil || acceptedAutomatic != 1 {
		t.Fatalf("accepted automatic classification count=%d err=%v", acceptedAutomatic, err)
	}

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
