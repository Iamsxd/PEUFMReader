package bibliography

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const maxDoubanResponseBytes = 2 << 20

var htmlTagPattern = regexp.MustCompile(`<[^>]*>`)

type Douban struct {
	baseURL string
	client  *http.Client
	limit   int
}

type doubanBook struct {
	ID          string   `json:"id"`
	Author      []string `json:"author"`
	Title       string   `json:"title"`
	ISBN13      string   `json:"isbn13"`
	Publisher   string   `json:"publisher"`
	PubDate     string   `json:"pubdate"`
	Summary     string   `json:"summary"`
	Category    string   `json:"category"`
	Translators []string `json:"translators"`
	Images      struct {
		Small  string `json:"small"`
		Medium string `json:"medium"`
		Large  string `json:"large"`
	} `json:"images"`
	Tags []struct {
		Name string `json:"name"`
	} `json:"tags"`
}

func NewDouban(baseURL string, timeout time.Duration, limit int) *Douban {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	client := &http.Client{Timeout: timeout}
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		origin := via[0].URL
		if request.URL.Scheme != origin.Scheme || request.URL.Host != origin.Host {
			return errors.New("cross-origin redirect refused")
		}
		return nil
	}
	return &Douban{baseURL: baseURL, client: client, limit: limit}
}

func (p *Douban) Name() string { return "豆瓣书目" }

func (p *Douban) Search(ctx context.Context, query Query) ([]Match, error) {
	isbn := normalizedISBN(query.ISBN)
	if isbn != "" {
		var book doubanBook
		if err := p.getJSON(ctx, "/v2/book/isbn/"+url.PathEscape(isbn), nil, &book); err != nil {
			return nil, err
		}
		return []Match{mapDoubanBook(query, book)}, nil
	}
	parameters := url.Values{"q": {strings.TrimSpace(query.Title)}, "count": {fmt.Sprintf("%d", p.limit)}}
	var payload struct {
		Code  int          `json:"code"`
		Msg   string       `json:"msg"`
		Books []doubanBook `json:"books"`
	}
	if err := p.getJSON(ctx, "/v2/book/search", parameters, &payload); err != nil {
		return nil, err
	}
	if payload.Code != 0 {
		return nil, fmt.Errorf("Douban API code %d: %s", payload.Code, payload.Msg)
	}
	matches := make([]Match, 0, len(payload.Books))
	for _, book := range payload.Books {
		matches = append(matches, mapDoubanBook(query, book))
	}
	return matches, nil
}

func (p *Douban) getJSON(ctx context.Context, path string, parameters url.Values, target any) error {
	if p.baseURL == "" {
		return errors.New("Douban API base URL is empty")
	}
	endpoint, err := url.Parse(p.baseURL + path)
	if err != nil {
		return err
	}
	endpoint.RawQuery = parameters.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "PEUFMReader/0.1 (self-hosted ebook catalog)")
	response, err := p.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		return fmt.Errorf("HTTP %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxDoubanResponseBytes))
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode Douban response: %w", err)
	}
	return nil
}

func mapDoubanBook(query Query, book doubanBook) Match {
	subjects := make([]string, 0, len(book.Tags)+1)
	if strings.TrimSpace(book.Category) != "" {
		subjects = append(subjects, strings.TrimSpace(book.Category))
	}
	for _, tag := range book.Tags {
		if strings.TrimSpace(tag.Name) != "" {
			subjects = append(subjects, strings.TrimSpace(tag.Name))
		}
	}
	coverURL := firstNonEmpty(book.Images.Medium, book.Images.Large, book.Images.Small)
	year := parsePublishedYear(strings.TrimSpace(book.PubDate))
	score, reason := confidence(query, book.Title, book.Author, book.ISBN13)
	sourceID := strings.TrimSpace(book.ID)
	if sourceID == "" {
		sourceID = firstNonEmpty(normalizedISBN(book.ISBN13), normalize(book.Title))
	}
	return Match{
		Source: "douban", SourceID: sourceID, Title: strings.TrimSpace(book.Title), Authors: book.Author,
		PublishedYear: year, ISBN: normalizedISBN(book.ISBN13), Publisher: strings.TrimSpace(book.Publisher),
		Description: plainText(book.Summary), Subjects: limitStrings(subjects, 20), CoverURL: coverURL,
		Confidence: score, Reason: reason,
	}
}

func plainText(value string) string {
	value = strings.ReplaceAll(value, "<br>", "\n")
	value = strings.ReplaceAll(value, "<br/>", "\n")
	value = strings.ReplaceAll(value, "<br />", "\n")
	return strings.TrimSpace(html.UnescapeString(htmlTagPattern.ReplaceAllString(value, "")))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
