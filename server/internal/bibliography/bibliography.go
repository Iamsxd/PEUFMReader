package bibliography

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

var ErrNoProviders = errors.New("no bibliography providers are configured")

type Query struct {
	Title    string
	Authors  []string
	ISBN     string
	Language string
}

type Match struct {
	Source        string   `json:"source"`
	SourceID      string   `json:"sourceId"`
	Title         string   `json:"title"`
	Authors       []string `json:"authors"`
	PublishedYear *int     `json:"publishedYear,omitempty"`
	Language      string   `json:"language,omitempty"`
	ISBN          string   `json:"isbn,omitempty"`
	Publisher     string   `json:"publisher,omitempty"`
	Description   string   `json:"description,omitempty"`
	Subjects      []string `json:"subjects"`
	CoverURL      string   `json:"coverUrl,omitempty"`
	Confidence    float64  `json:"confidence"`
	Reason        string   `json:"reason"`
}

type SearchResult struct {
	Matches  []Match  `json:"matches"`
	Warnings []string `json:"warnings"`
}

type Provider interface {
	Name() string
	Search(context.Context, Query) ([]Match, error)
}

type SourceConfig struct {
	ID         int64
	Provider   string
	BaseURL    string
	Priority   int
	Timeout    time.Duration
	MaxResults int
}

type SourceLoader func(context.Context, bool) ([]SourceConfig, error)
type StatusRecorder func(context.Context, int64, bool, time.Duration, string) error

type ProbeResult struct {
	Success   bool   `json:"success"`
	LatencyMS int64  `json:"latencyMs"`
	Error     string `json:"error,omitempty"`
}

type Service struct {
	providers      []Provider
	loadSources    SourceLoader
	recordStatus   StatusRecorder
	googleBooksKey string
}

func NewService(providers ...Provider) *Service {
	return &Service{providers: providers}
}

func NewDynamicService(loader SourceLoader, recorder StatusRecorder, googleBooksKey string) *Service {
	return &Service{loadSources: loader, recordStatus: recorder, googleBooksKey: googleBooksKey}
}

func (s *Service) Available() bool {
	return len(s.providers) > 0 || s.loadSources != nil
}

func (s *Service) Search(ctx context.Context, query Query) (SearchResult, error) {
	return s.search(ctx, query, false)
}

func (s *Service) SearchAutomatic(ctx context.Context, query Query) (SearchResult, error) {
	return s.search(ctx, query, true)
}

type activeProvider struct {
	provider Provider
	sourceID int64
	priority int
}

func (s *Service) activeProviders(ctx context.Context, automaticOnly bool) ([]activeProvider, error) {
	if s.loadSources == nil {
		items := make([]activeProvider, 0, len(s.providers))
		for index, provider := range s.providers {
			items = append(items, activeProvider{provider: provider, priority: index + 1})
		}
		return items, nil
	}
	sources, err := s.loadSources(ctx, automaticOnly)
	if err != nil {
		return nil, fmt.Errorf("load bibliography sources: %w", err)
	}
	items := make([]activeProvider, 0, len(sources))
	for _, source := range sources {
		provider, providerErr := ProviderForSource(source, s.googleBooksKey)
		if providerErr != nil {
			return nil, providerErr
		}
		items = append(items, activeProvider{provider: provider, sourceID: source.ID, priority: source.Priority})
	}
	return items, nil
}

func ProviderForSource(source SourceConfig, googleBooksKey string) (Provider, error) {
	limit := source.MaxResults
	if limit < 1 || limit > 20 {
		limit = 5
	}
	timeout := source.Timeout
	if timeout <= 0 || timeout > time.Minute {
		timeout = 8 * time.Second
	}
	switch source.Provider {
	case "douban":
		return NewDouban(source.BaseURL, timeout, limit), nil
	case "openlibrary":
		return newOpenLibrary(source.BaseURL, timeout, limit), nil
	case "google-books":
		return newGoogleBooks(source.BaseURL, googleBooksKey, timeout, limit), nil
	default:
		return nil, fmt.Errorf("unsupported bibliography provider %q", source.Provider)
	}
}

func (s *Service) TestSource(ctx context.Context, source SourceConfig) ProbeResult {
	provider, err := ProviderForSource(source, s.googleBooksKey)
	if err != nil {
		return ProbeResult{Error: err.Error()}
	}
	startedAt := time.Now()
	_, err = provider.Search(ctx, Query{Title: "PEUFMReader connection test"})
	latency := time.Since(startedAt)
	result := ProbeResult{Success: err == nil, LatencyMS: latency.Milliseconds()}
	if err != nil {
		result.Error = err.Error()
	}
	if s.recordStatus != nil && source.ID > 0 {
		_ = s.recordStatus(ctx, source.ID, result.Success, latency, result.Error)
	}
	return result
}

func (s *Service) search(ctx context.Context, query Query, automaticOnly bool) (SearchResult, error) {
	if !s.Available() {
		return SearchResult{}, ErrNoProviders
	}
	if strings.TrimSpace(query.ISBN) == "" && strings.TrimSpace(query.Title) == "" {
		return SearchResult{}, errors.New("ISBN or title is required for bibliography search")
	}
	providers, err := s.activeProviders(ctx, automaticOnly)
	if err != nil {
		return SearchResult{}, err
	}
	if len(providers) == 0 {
		return SearchResult{}, ErrNoProviders
	}

	type providerResult struct {
		name     string
		priority int
		matches  []Match
		err      error
	}
	results := make(chan providerResult, len(providers))
	var group sync.WaitGroup
	for _, active := range providers {
		group.Add(1)
		go func(active activeProvider) {
			defer group.Done()
			startedAt := time.Now()
			matches, searchErr := active.provider.Search(ctx, query)
			latency := time.Since(startedAt)
			if s.recordStatus != nil && active.sourceID > 0 {
				errorMessage := ""
				if searchErr != nil {
					errorMessage = searchErr.Error()
				}
				_ = s.recordStatus(ctx, active.sourceID, searchErr == nil, latency, errorMessage)
			}
			results <- providerResult{name: active.provider.Name(), priority: active.priority, matches: matches, err: searchErr}
		}(active)
	}
	group.Wait()
	close(results)

	result := SearchResult{Matches: []Match{}, Warnings: []string{}}
	priorities := make(map[string]int)
	for providerResult := range results {
		if providerResult.err != nil {
			result.Warnings = append(result.Warnings, providerResult.name+" query failed: "+providerResult.err.Error())
			continue
		}
		for _, match := range providerResult.matches {
			priorities[match.Source] = providerResult.priority
		}
		result.Matches = append(result.Matches, providerResult.matches...)
	}
	sort.SliceStable(result.Matches, func(i, j int) bool {
		if result.Matches[i].Confidence == result.Matches[j].Confidence {
			return priorities[result.Matches[i].Source] < priorities[result.Matches[j].Source]
		}
		return result.Matches[i].Confidence > result.Matches[j].Confidence
	})
	if len(result.Matches) > 20 {
		result.Matches = result.Matches[:20]
	}
	if len(result.Matches) == 0 && len(result.Warnings) == len(providers) {
		return result, errors.New(strings.Join(result.Warnings, "; "))
	}
	return result, nil
}

func confidence(query Query, title string, authors []string, isbn string) (float64, string) {
	if normalizedISBN(query.ISBN) != "" && normalizedISBN(query.ISBN) == normalizedISBN(isbn) {
		return 0.97, "ISBN 精确匹配"
	}
	titleMatches := normalize(query.Title) != "" && normalize(query.Title) == normalize(title)
	authorMatches := false
	for _, queryAuthor := range query.Authors {
		for _, candidateAuthor := range authors {
			if normalize(queryAuthor) != "" && normalize(queryAuthor) == normalize(candidateAuthor) {
				authorMatches = true
			}
		}
	}
	if titleMatches && authorMatches {
		return 0.9, "书名与作者精确匹配"
	}
	if titleMatches {
		return 0.82, "书名精确匹配"
	}
	return 0.68, "外部书目相关结果"
}

func normalize(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(value)), " "))
}

func normalizedISBN(value string) string {
	var builder strings.Builder
	for _, character := range strings.ToUpper(value) {
		if character >= '0' && character <= '9' || character == 'X' {
			builder.WriteRune(character)
		}
	}
	return builder.String()
}

func first(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return strings.TrimSpace(values[0])
}
