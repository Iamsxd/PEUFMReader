package httpapi

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"peufmreader/internal/store"
)

func TestNotebookExportLiteralMarkdownAndStructuredJSON(t *testing.T) {
	now := time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC)
	malicious := "![tracking](https://example.invalid/pixel) <img src=\"https://example.invalid/x\"> <script>alert(1)</script> &lt;script&gt;\n[link](javascript:alert(1)) `code`"
	item := store.NotebookEntry{
		ReadingMark: store.ReadingMark{ID: 1, BookFileID: 2, Kind: "highlight", Position: json.RawMessage(`{"cfi":"epubcfi(/6/2!/4/1:0)","pageIndex":3}`), OverallProgress: .5, Label: malicious, Body: malicious, Quote: malicious, Color: "blue", CreatedAt: now, UpdatedAt: now},
		BookTitle:   malicious, BookFormat: "epub",
	}
	query := store.NotebookQuery{Query: "100%", Kind: "highlight", Color: "blue", BookFileID: 2}
	markdown, err := renderNotebookExport([]store.NotebookEntry{item}, query, "markdown", now, store.MaxNotebookExportBytes)
	if err != nil {
		t.Fatal(err)
	}
	activeSyntax := regexp.MustCompile(`(^|[^\\])(!\[tracking\]|<img|<script|\[link\]\(|https://example\.invalid)`)
	if activeSyntax.Match(markdown) {
		t.Fatalf("active Markdown syntax remained: %s", markdown)
	}
	if !strings.Contains(string(markdown), `\!\[tracking\]`) || !strings.Contains(string(markdown), `&lt;img`) || !strings.Contains(string(markdown), `epubcfi`) || !strings.Contains(string(markdown), "更新时间") {
		t.Fatalf("Markdown lost escaped content or location/time metadata: %s", markdown)
	}
	encoded, err := renderNotebookExport([]store.NotebookEntry{item}, query, "json", now, store.MaxNotebookExportBytes)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Version     int
		GeneratedAt time.Time
		Filters     notebookExportFilters
		Items       []store.NotebookEntry
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Version != 1 || !decoded.GeneratedAt.Equal(now) || decoded.Filters.Query != "100%" || decoded.Filters.BookFileID != 2 || len(decoded.Items) != 1 || decoded.Items[0].BookTitle != malicious || decoded.Items[0].Body != malicious || string(decoded.Items[0].Position) != string(item.Position) {
		t.Fatalf("structured export lost content: %+v", decoded)
	}
}

func TestNotebookExportEncodedByteLimitHasNoPartialOutput(t *testing.T) {
	for _, format := range []string{"markdown", "json"} {
		t.Run(format, func(t *testing.T) {
			data, err := renderNotebookExport(nil, store.NotebookQuery{}, format, time.Unix(0, 0).UTC(), store.MaxNotebookExportBytes)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := renderNotebookExport(nil, store.NotebookQuery{}, format, time.Unix(0, 0).UTC(), len(data)); err != nil {
				t.Fatal("exact byte limit rejected", err)
			}
			partial, err := renderNotebookExport(nil, store.NotebookQuery{}, format, time.Unix(0, 0).UTC(), len(data)-1)
			if !errors.Is(err, store.ErrNotebookExportTooLarge) {
				t.Fatalf("limit error=%v", err)
			}
			if len(partial) != 0 {
				t.Fatal("oversized export returned partial bytes")
			}
		})
	}
	giantTitle := strings.Repeat("<", store.MaxNotebookExportBytes/6+1)
	_, err := renderNotebookExport([]store.NotebookEntry{{BookTitle: giantTitle, ReadingMark: store.ReadingMark{Position: json.RawMessage(`{}`)}}}, store.NotebookQuery{}, "json", time.Unix(0, 0).UTC(), store.MaxNotebookExportBytes)
	if !errors.Is(err, store.ErrNotebookExportTooLarge) {
		t.Fatalf("escaped giant title error=%v", err)
	}
}

func TestSharedNotebookFilterValidation(t *testing.T) {
	for _, query := range []string{"q=" + strings.Repeat("笔", 201), "kind=unknown", "color=red", "bookId=0", "bookId=-1", "bookId=bad"} {
		recorder := httptest.NewRecorder()
		_, ok := parseNotebookFilters(recorder, httptest.NewRequest("GET", "/api/v1/notebook?"+query, nil))
		if ok || recorder.Code != 400 {
			t.Fatalf("query=%q accepted=%v status=%d", query, ok, recorder.Code)
		}
	}
	recorder := httptest.NewRecorder()
	query, ok := parseNotebookFilters(recorder, httptest.NewRequest("GET", "/api/v1/notebook?q=%20hello%20&kind=note&bookId=3", nil))
	if !ok || query.Query != "hello" || query.Kind != "note" || query.BookFileID != 3 {
		t.Fatalf("normalization=%+v ok=%v", query, ok)
	}
}
