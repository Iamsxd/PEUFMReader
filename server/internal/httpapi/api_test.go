package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestValidPosition(t *testing.T) {
	tests := []struct {
		name  string
		value json.RawMessage
		valid bool
	}{
		{name: "EPUB", value: json.RawMessage(`{"cfi":"epubcfi(/6/2)","progression":0.5}`), valid: true},
		{name: "PDF", value: json.RawMessage(`{"pageIndex":4,"yRatio":0.2}`), valid: true},
		{name: "array", value: json.RawMessage(`[]`), valid: false},
		{name: "null", value: json.RawMessage(`null`), valid: false},
		{name: "invalid", value: json.RawMessage(`{`), valid: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := validPosition(test.value); got != test.valid {
				t.Fatalf("validPosition(%s)=%v, want %v", test.value, got, test.valid)
			}
		})
	}
}

func TestParseIDRejectsInvalidValues(t *testing.T) {
	for _, value := range []string{"", "0", "-1", "abc"} {
		recorder := httptest.NewRecorder()
		if _, ok := parseID(recorder, value); ok {
			t.Fatalf("parseID accepted %q", value)
		}
		if recorder.Code != 400 {
			t.Fatalf("parseID(%q) status=%d", value, recorder.Code)
		}
	}
}

func TestParseCatalogQuery(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/book-files?q=%E4%B8%89%E4%BD%93&category=science-fiction&format=pdf&status=reading&sort=hot&page=2&pageSize=36", nil)
	query, err := parseCatalogQuery(request)
	if err != nil {
		t.Fatal(err)
	}
	if query.Query != "三体" || query.CategorySlug != "science-fiction" || query.Format != "pdf" || query.Status != "reading" || query.Sort != "hot" {
		t.Fatalf("filters not parsed: %#v", query)
	}
	if query.Page != 2 || query.PageSize != 36 {
		t.Fatalf("pagination not parsed: %#v", query)
	}
}

func TestParseCatalogQueryDefaultsToRelevance(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/book-files?q=reader", nil)
	query, err := parseCatalogQuery(request)
	if err != nil {
		t.Fatal(err)
	}
	if query.Sort != "relevance" || query.Page != 1 || query.PageSize != 24 {
		t.Fatalf("unexpected defaults: %#v", query)
	}
}

func TestParseCatalogQueryRejectsInvalidPaginationAndFilters(t *testing.T) {
	for _, target := range []string{
		"/api/v1/book-files?page=0",
		"/api/v1/book-files?pageSize=101",
		"/api/v1/book-files?format=mobi",
		"/api/v1/book-files?status=unknown",
		"/api/v1/book-files?sort=random",
	} {
		request := httptest.NewRequest(http.MethodGet, target, nil)
		if _, err := parseCatalogQuery(request); err == nil {
			t.Fatalf("parseCatalogQuery accepted %s", target)
		}
	}
}

func TestParsePagination(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/favorites?page=3&pageSize=18", nil)
	page, pageSize, err := parsePagination(request, 24, 100)
	if err != nil {
		t.Fatal(err)
	}
	if page != 3 || pageSize != 18 {
		t.Fatalf("unexpected pagination: page=%d pageSize=%d", page, pageSize)
	}
}

func TestParsePaginationRejectsInvalidValues(t *testing.T) {
	for _, target := range []string{
		"/api/v1/favorites?page=0",
		"/api/v1/favorites?page=nope",
		"/api/v1/favorites?pageSize=0",
		"/api/v1/favorites?pageSize=101",
	} {
		request := httptest.NewRequest(http.MethodGet, target, nil)
		if _, _, err := parsePagination(request, 24, 100); err == nil {
			t.Fatalf("parsePagination accepted %s", target)
		}
	}
}
