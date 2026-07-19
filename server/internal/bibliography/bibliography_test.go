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
