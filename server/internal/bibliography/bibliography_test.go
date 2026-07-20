package bibliography

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOpenLibrarySearchUsesISBNAndMapsCandidate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search.json" || r.URL.Query().Get("isbn") != "9787536692930" {
			t.Fatalf("unexpected request %s", r.URL.String())
		}
		_, _ = w.Write([]byte(`{"docs":[{"key":"/works/OL1W","title":"三体","author_name":["刘慈欣"],"first_publish_year":2008,"language":["chi"],"isbn":["9787536692930"],"publisher":["重庆出版社"],"subject":["科幻"],"cover_i":123}]}`))
	}))
	defer server.Close()

	matches, err := NewOpenLibrary(server.URL, time.Second).Search(context.Background(), Query{Title: "三体", Authors: []string{"刘慈欣"}, ISBN: "978-7-5366-9293-0"})
	if err != nil || len(matches) != 1 {
		t.Fatalf("Search() matches=%+v err=%v", matches, err)
	}
	if matches[0].Confidence != 0.97 || matches[0].CoverURL != "https://covers.openlibrary.org/b/id/123-M.jpg" {
		t.Fatalf("unexpected match %+v", matches[0])
	}
}

func TestGoogleBooksSearchMapsVolumeMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Query().Get("q"), "intitle:Clean Code") || r.URL.Query().Get("key") != "secret" {
			t.Fatalf("unexpected query %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"volume-1","volumeInfo":{"title":"Clean Code","authors":["Robert C. Martin"],"publisher":"Prentice Hall","publishedDate":"2008-08-01","description":"A handbook","industryIdentifiers":[{"type":"ISBN_13","identifier":"9780132350884"}],"categories":["Computers"],"language":"en","imageLinks":{"thumbnail":"http://example.test/cover.jpg"}}}]}`))
	}))
	defer server.Close()

	matches, err := NewGoogleBooks(server.URL, "secret", time.Second).Search(context.Background(), Query{Title: "Clean Code", Authors: []string{"Robert C. Martin"}})
	if err != nil || len(matches) != 1 {
		t.Fatalf("Search() matches=%+v err=%v", matches, err)
	}
	if matches[0].PublishedYear == nil || *matches[0].PublishedYear != 2008 || matches[0].CoverURL != "https://example.test/cover.jpg" {
		t.Fatalf("unexpected match %+v", matches[0])
	}
}

func TestDoubanSearchMapsBookMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/book/search" || r.URL.Query().Get("q") != "一个人的村庄" || r.URL.Query().Get("count") != "3" {
			t.Fatalf("unexpected request %s", r.URL.String())
		}
		_, _ = w.Write([]byte(`{"code":0,"msg":"","books":[{"id":"1234","author":["刘亮程"],"title":"一个人的村庄","isbn13":"9787532151622","publisher":"上海文艺出版社","pubdate":"2014-01","summary":"第一段<br>第二段","images":{"medium":"http://example.test/cover.jpg"},"tags":[{"name":"散文"},{"name":"中国文学"}]}]}`))
	}))
	defer server.Close()

	matches, err := NewDouban(server.URL, time.Second, 3).Search(context.Background(), Query{Title: "一个人的村庄", Authors: []string{"刘亮程"}})
	if err != nil || len(matches) != 1 {
		t.Fatalf("Search() matches=%+v err=%v", matches, err)
	}
	match := matches[0]
	if match.Source != "douban" || match.SourceID != "1234" || match.PublishedYear == nil || *match.PublishedYear != 2014 {
		t.Fatalf("unexpected match %+v", match)
	}
	if match.Description != "第一段\n第二段" || len(match.Subjects) != 2 || match.Subjects[0] != "散文" {
		t.Fatalf("metadata was not mapped: %+v", match)
	}
}

func TestDoubanISBNUsesDetailEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/book/isbn/9787532151622" {
			t.Fatalf("unexpected request %s", r.URL.String())
		}
		_, _ = w.Write([]byte(`{"id":"1234","author":["刘亮程"],"title":"一个人的村庄","isbn13":"9787532151622","publisher":"上海文艺出版社","pubdate":"2014"}`))
	}))
	defer server.Close()

	matches, err := NewDouban(server.URL, time.Second, 5).Search(context.Background(), Query{ISBN: "978-7-5321-5162-2"})
	if err != nil || len(matches) != 1 || matches[0].Confidence != 0.97 {
		t.Fatalf("Search() matches=%+v err=%v", matches, err)
	}
}

func TestDynamicServiceLoadsAutomaticSourcesAndRecordsStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "2" {
			t.Fatalf("configured candidate limit was not used: %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"docs":[]}`))
	}))
	defer server.Close()

	loadedAutomatic := false
	recorded := false
	service := NewDynamicService(func(_ context.Context, automaticOnly bool) ([]SourceConfig, error) {
		loadedAutomatic = automaticOnly
		return []SourceConfig{{ID: 7, Provider: "openlibrary", BaseURL: server.URL, Priority: 20, Timeout: time.Second, MaxResults: 2}}, nil
	}, func(_ context.Context, sourceID int64, success bool, _ time.Duration, errorMessage string) error {
		recorded = sourceID == 7 && success && errorMessage == ""
		return nil
	}, "")

	result, err := service.SearchAutomatic(context.Background(), Query{Title: "test"})
	if err != nil || len(result.Matches) != 0 {
		t.Fatalf("SearchAutomatic() result=%+v err=%v", result, err)
	}
	if !loadedAutomatic || !recorded {
		t.Fatalf("automatic=%v recorded=%v", loadedAutomatic, recorded)
	}
}
