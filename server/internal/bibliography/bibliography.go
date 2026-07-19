package bibliography

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
)

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

type Service struct {
	providers []Provider
}

func NewService(providers ...Provider) *Service {
	return &Service{providers: providers}
}

func (s *Service) Available() bool {
	return len(s.providers) > 0
}

func (s *Service) Search(ctx context.Context, query Query) (SearchResult, error) {
	if !s.Available() {
		return SearchResult{}, errors.New("no bibliography providers are configured")
	}
	if strings.TrimSpace(query.ISBN) == "" && strings.TrimSpace(query.Title) == "" {
		return SearchResult{}, errors.New("ISBN or title is required for bibliography search")
	}

	type providerResult struct {
		name    string
		matches []Match
		err     error
	}
	results := make(chan providerResult, len(s.providers))
	var group sync.WaitGroup
	for _, provider := range s.providers {
		group.Add(1)
		go func(provider Provider) {
			defer group.Done()
			matches, err := provider.Search(ctx, query)
			results <- providerResult{name: provider.Name(), matches: matches, err: err}
		}(provider)
	}
	group.Wait()
	close(results)

	result := SearchResult{Matches: []Match{}, Warnings: []string{}}
	for providerResult := range results {
		if providerResult.err != nil {
			result.Warnings = append(result.Warnings, providerResult.name+" 查询失败："+providerResult.err.Error())
			continue
		}
		result.Matches = append(result.Matches, providerResult.matches...)
	}
	sort.SliceStable(result.Matches, func(i, j int) bool { return result.Matches[i].Confidence > result.Matches[j].Confidence })
	if len(result.Matches) > 10 {
		result.Matches = result.Matches[:10]
	}
	if len(result.Matches) == 0 && len(result.Warnings) == len(s.providers) {
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
