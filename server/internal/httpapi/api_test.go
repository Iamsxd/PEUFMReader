package httpapi

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientIPOnlyTrustsForwardingHeaderFromConfiguredProxy(t *testing.T) {
	_, trusted, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatal(err)
	}
	api := &API{trustedProxy: trusted}
	trustedRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	trustedRequest.RemoteAddr = "10.0.0.2:1234"
	trustedRequest.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.2")
	if got := api.clientIP(trustedRequest); got != "203.0.113.7" {
		t.Fatalf("trusted proxy client IP=%q", got)
	}
	untrustedRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	untrustedRequest.RemoteAddr = "192.168.1.5:1234"
	untrustedRequest.Header.Set("X-Forwarded-For", "203.0.113.8")
	if got := api.clientIP(untrustedRequest); got != "192.168.1.5" {
		t.Fatalf("untrusted forwarding header accepted: %q", got)
	}
}

func TestCategorySlugPattern(t *testing.T) {
	for _, valid := range []string{"literature", "science-fiction", "ai-data-2"} {
		if !categorySlugPattern.MatchString(valid) {
			t.Fatalf("valid category slug rejected: %s", valid)
		}
	}
	for _, invalid := range []string{"", "中文", "Bad-Slug", "two words", "-leading", "trailing-"} {
		if categorySlugPattern.MatchString(invalid) {
			t.Fatalf("invalid category slug accepted: %s", invalid)
		}
	}
}

func TestValidUsername(t *testing.T) {
	for _, valid := range []string{"reader", "reader-2", "张三", "user.name_3"} {
		if !validUsername(valid) {
			t.Fatalf("valid username rejected: %q", valid)
		}
	}
	for _, invalid := range []string{"", "-reader", "two words", "reader/2", string(make([]byte, 65))} {
		if validUsername(invalid) {
			t.Fatalf("invalid username accepted: %q", invalid)
		}
	}
}

func TestTruncateRunesPreservesUnicode(t *testing.T) {
	if got := truncateRunes(" 阅读设备 ", 3); got != "阅读设" {
		t.Fatalf("truncateRunes()=%q", got)
	}
}

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
