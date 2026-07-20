package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

type BibliographySource struct {
	ID            int64      `json:"id"`
	Provider      string     `json:"provider"`
	Enabled       bool       `json:"enabled"`
	BaseURL       string     `json:"baseUrl"`
	Priority      int        `json:"priority"`
	TimeoutMS     int        `json:"timeoutMs"`
	MaxResults    int        `json:"maxResults"`
	AutoSearch    bool       `json:"autoSearch"`
	LastCheckedAt *time.Time `json:"lastCheckedAt,omitempty"`
	LastSuccessAt *time.Time `json:"lastSuccessAt,omitempty"`
	LastLatencyMS *int       `json:"lastLatencyMs,omitempty"`
	LastError     string     `json:"lastError,omitempty"`
	UpdatedAt     time.Time  `json:"updatedAt"`
}

type BibliographySourceDefault struct {
	Provider   string
	Enabled    bool
	BaseURL    string
	Priority   int
	TimeoutMS  int
	MaxResults int
	AutoSearch bool
}

type BibliographySourceUpdate struct {
	Enabled    bool
	BaseURL    string
	Priority   int
	TimeoutMS  int
	MaxResults int
	AutoSearch bool
}

const bibliographySourceColumns = `id,provider,enabled,base_url,priority,timeout_ms,max_results,auto_search,
    last_checked_at,last_success_at,last_latency_ms,last_error,updated_at`

type bibliographySourceScanner interface {
	Scan(dest ...any) error
}

func scanBibliographySource(scanner bibliographySourceScanner) (BibliographySource, error) {
	var source BibliographySource
	err := scanner.Scan(&source.ID, &source.Provider, &source.Enabled, &source.BaseURL, &source.Priority,
		&source.TimeoutMS, &source.MaxResults, &source.AutoSearch, &source.LastCheckedAt,
		&source.LastSuccessAt, &source.LastLatencyMS, &source.LastError, &source.UpdatedAt)
	return source, err
}

// EnsureBibliographySources creates missing built-in providers without overwriting administrator changes.
func (s *Store) EnsureBibliographySources(ctx context.Context, defaults []BibliographySourceDefault) error {
	for _, item := range defaults {
		_, err := s.pool.Exec(ctx, `
			INSERT INTO bibliography_sources(provider,enabled,base_url,priority,timeout_ms,max_results,auto_search)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT(provider) DO NOTHING`, item.Provider, item.Enabled, item.BaseURL, item.Priority,
			item.TimeoutMS, item.MaxResults, item.AutoSearch)
		if err != nil {
			return fmt.Errorf("ensure bibliography source %s: %w", item.Provider, err)
		}
	}
	return nil
}

func (s *Store) ListBibliographySources(ctx context.Context) ([]BibliographySource, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+bibliographySourceColumns+`
		FROM bibliography_sources ORDER BY priority,provider`)
	if err != nil {
		return nil, fmt.Errorf("list bibliography sources: %w", err)
	}
	defer rows.Close()
	items := make([]BibliographySource, 0)
	for rows.Next() {
		item, scanErr := scanBibliographySource(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("scan bibliography source: %w", scanErr)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) GetBibliographySource(ctx context.Context, id int64) (BibliographySource, bool, error) {
	item, err := scanBibliographySource(s.pool.QueryRow(ctx, `SELECT `+bibliographySourceColumns+`
		FROM bibliography_sources WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return BibliographySource{}, false, nil
	}
	if err != nil {
		return BibliographySource{}, false, fmt.Errorf("get bibliography source: %w", err)
	}
	return item, true, nil
}

func (s *Store) ListEnabledBibliographySources(ctx context.Context, automaticOnly bool) ([]BibliographySource, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+bibliographySourceColumns+`
		FROM bibliography_sources
		WHERE enabled=true AND ($1=false OR auto_search=true)
		ORDER BY priority,provider`, automaticOnly)
	if err != nil {
		return nil, fmt.Errorf("list enabled bibliography sources: %w", err)
	}
	defer rows.Close()
	items := make([]BibliographySource, 0)
	for rows.Next() {
		item, scanErr := scanBibliographySource(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("scan enabled bibliography source: %w", scanErr)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) UpdateBibliographySource(ctx context.Context, id int64, input BibliographySourceUpdate) (BibliographySource, bool, error) {
	item, err := scanBibliographySource(s.pool.QueryRow(ctx, `
		UPDATE bibliography_sources SET enabled=$2,base_url=$3,priority=$4,timeout_ms=$5,max_results=$6,
			auto_search=$7,updated_at=NOW()
		WHERE id=$1
		RETURNING `+bibliographySourceColumns, id, input.Enabled, input.BaseURL, input.Priority,
		input.TimeoutMS, input.MaxResults, input.AutoSearch))
	if errors.Is(err, pgx.ErrNoRows) {
		return BibliographySource{}, false, nil
	}
	if err != nil {
		return BibliographySource{}, false, fmt.Errorf("update bibliography source: %w", err)
	}
	return item, true, nil
}
