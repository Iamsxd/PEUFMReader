package bibliography

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type OpenLibrary struct {
	baseURL string
	client  *http.Client
}

func NewOpenLibrary(baseURL string, timeout time.Duration) *OpenLibrary {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "https://openlibrary.org"
	}
	return &OpenLibrary{baseURL: strings.TrimRight(baseURL, "/"), client: &http.Client{Timeout: timeout}}
}

func (p *OpenLibrary) Name() string { return "Open Library" }

func (p *OpenLibrary) Search(ctx context.Context, query Query) ([]Match, error) {
	endpoint, err := url.Parse(p.baseURL + "/search.json")
	if err != nil {
		return nil, err
	}
	parameters := endpoint.Query()
	if normalizedISBN(query.ISBN) != "" {
		parameters.Set("isbn", normalizedISBN(query.ISBN))
	} else {
		parameters.Set("title", query.Title)
		if len(query.Authors) > 0 {
			parameters.Set("author", query.Authors[0])
		}
	}
	parameters.Set("fields", "key,title,author_name,first_publish_year,language,isbn,publisher,subject,cover_i")
	parameters.Set("limit", "5")
	if len(query.Language) >= 2 {
		parameters.Set("lang", query.Language[:2])
	}
	endpoint.RawQuery = parameters.Encode()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "PEUFMReader/0.1 (self-hosted ebook catalog)")
	response, err := p.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	var payload struct {
		Docs []struct {
			Key              string   `json:"key"`
			Title            string   `json:"title"`
			Authors          []string `json:"author_name"`
			FirstPublishYear *int     `json:"first_publish_year"`
			Languages        []string `json:"language"`
			ISBNs            []string `json:"isbn"`
			Publishers       []string `json:"publisher"`
			Subjects         []string `json:"subject"`
			CoverID          *int64   `json:"cover_i"`
		} `json:"docs"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode Open Library response: %w", err)
	}
	matches := make([]Match, 0, len(payload.Docs))
	for _, document := range payload.Docs {
		isbn := chooseISBN(query.ISBN, document.ISBNs)
		score, reason := confidence(query, document.Title, document.Authors, isbn)
		coverURL := ""
		if document.CoverID != nil {
			coverURL = "https://covers.openlibrary.org/b/id/" + strconv.FormatInt(*document.CoverID, 10) + "-M.jpg"
		}
		matches = append(matches, Match{
			Source: "openlibrary", SourceID: document.Key, Title: document.Title, Authors: document.Authors,
			PublishedYear: document.FirstPublishYear, Language: first(document.Languages), ISBN: isbn,
			Publisher: first(document.Publishers), Subjects: limitStrings(document.Subjects, 20), CoverURL: coverURL,
			Confidence: score, Reason: reason,
		})
	}
	return matches, nil
}

func chooseISBN(requested string, candidates []string) string {
	requested = normalizedISBN(requested)
	for _, candidate := range candidates {
		if requested != "" && normalizedISBN(candidate) == requested {
			return normalizedISBN(candidate)
		}
	}
	for _, candidate := range candidates {
		if len(normalizedISBN(candidate)) == 13 {
			return normalizedISBN(candidate)
		}
	}
	if len(candidates) > 0 {
		return normalizedISBN(candidates[0])
	}
	return ""
}

func limitStrings(values []string, limit int) []string {
	if len(values) <= limit {
		return values
	}
	return values[:limit]
}
