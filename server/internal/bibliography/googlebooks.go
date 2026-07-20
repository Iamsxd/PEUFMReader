package bibliography

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type GoogleBooks struct {
	baseURL string
	apiKey  string
	client  *http.Client
	limit   int
}

func NewGoogleBooks(baseURL, apiKey string, timeout time.Duration) *GoogleBooks {
	return newGoogleBooks(baseURL, apiKey, timeout, 5)
}

func newGoogleBooks(baseURL, apiKey string, timeout time.Duration, limit int) *GoogleBooks {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "https://www.googleapis.com/books/v1"
	}
	return &GoogleBooks{baseURL: strings.TrimRight(baseURL, "/"), apiKey: apiKey, client: &http.Client{Timeout: timeout}, limit: limit}
}

func (p *GoogleBooks) Name() string { return "Google Books" }

func (p *GoogleBooks) Search(ctx context.Context, query Query) ([]Match, error) {
	endpoint, err := url.Parse(p.baseURL + "/volumes")
	if err != nil {
		return nil, err
	}
	search := "isbn:" + normalizedISBN(query.ISBN)
	if normalizedISBN(query.ISBN) == "" {
		search = "intitle:" + query.Title
		if len(query.Authors) > 0 {
			search += " inauthor:" + query.Authors[0]
		}
	}
	parameters := endpoint.Query()
	parameters.Set("q", search)
	parameters.Set("maxResults", fmt.Sprintf("%d", p.limit))
	parameters.Set("printType", "books")
	if p.apiKey != "" {
		parameters.Set("key", p.apiKey)
	}
	endpoint.RawQuery = parameters.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	var payload struct {
		Items []struct {
			ID         string `json:"id"`
			VolumeInfo struct {
				Title               string   `json:"title"`
				Authors             []string `json:"authors"`
				Publisher           string   `json:"publisher"`
				PublishedDate       string   `json:"publishedDate"`
				Description         string   `json:"description"`
				IndustryIdentifiers []struct {
					Type       string `json:"type"`
					Identifier string `json:"identifier"`
				} `json:"industryIdentifiers"`
				Categories []string `json:"categories"`
				Language   string   `json:"language"`
				ImageLinks struct {
					Thumbnail string `json:"thumbnail"`
				} `json:"imageLinks"`
			} `json:"volumeInfo"`
		} `json:"items"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode Google Books response: %w", err)
	}
	matches := make([]Match, 0, len(payload.Items))
	for _, item := range payload.Items {
		isbn := googleISBN(item.VolumeInfo.IndustryIdentifiers)
		year := parsePublishedYear(item.VolumeInfo.PublishedDate)
		score, reason := confidence(query, item.VolumeInfo.Title, item.VolumeInfo.Authors, isbn)
		matches = append(matches, Match{
			Source: "google-books", SourceID: item.ID, Title: item.VolumeInfo.Title, Authors: item.VolumeInfo.Authors,
			PublishedYear: year, Language: item.VolumeInfo.Language, ISBN: isbn, Publisher: item.VolumeInfo.Publisher,
			Description: item.VolumeInfo.Description, Subjects: limitStrings(item.VolumeInfo.Categories, 20),
			CoverURL:   strings.Replace(item.VolumeInfo.ImageLinks.Thumbnail, "http://", "https://", 1),
			Confidence: score, Reason: reason,
		})
	}
	return matches, nil
}

func googleISBN(identifiers []struct {
	Type       string `json:"type"`
	Identifier string `json:"identifier"`
}) string {
	for _, identifier := range identifiers {
		if identifier.Type == "ISBN_13" {
			return normalizedISBN(identifier.Identifier)
		}
	}
	if len(identifiers) > 0 {
		return normalizedISBN(identifiers[0].Identifier)
	}
	return ""
}

func parsePublishedYear(value string) *int {
	if len(value) < 4 {
		return nil
	}
	var year int
	if _, err := fmt.Sscanf(value[:4], "%d", &year); err != nil || year < 0 || year > 9999 {
		return nil
	}
	return &year
}
