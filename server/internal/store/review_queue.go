package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	DefaultReviewQueuePageSize = 20
	MaxReviewQueuePageSize     = 100
)

type ReviewQueueQuery struct {
	Query    string
	Format   string
	Reason   string
	Sort     string
	Page     int
	PageSize int
}

type ReviewQueueSummary struct {
	EditionID                    int64     `json:"editionId"`
	WorkID                       int64     `json:"workId"`
	BookFileID                   int64     `json:"bookFileId"`
	Title                        string    `json:"title"`
	Authors                      []string  `json:"authors"`
	Format                       string    `json:"format"`
	OriginalFilename             string    `json:"originalFilename"`
	MetadataPending              bool      `json:"metadataPending"`
	CandidateCount               int       `json:"candidateCount"`
	SuggestedClassificationCount int       `json:"suggestedClassificationCount"`
	UpdatedAt                    time.Time `json:"updatedAt"`
}

type ReviewQueuePage struct {
	Items      []ReviewQueueSummary `json:"items"`
	Total      int                  `json:"total"`
	Page       int                  `json:"page"`
	PageSize   int                  `json:"pageSize"`
	TotalPages int                  `json:"totalPages"`
}

func NormalizeReviewQueueQuery(query ReviewQueueQuery) ReviewQueueQuery {
	query.Query = strings.TrimSpace(query.Query)
	query.Format = strings.ToLower(strings.TrimSpace(query.Format))
	query.Reason = strings.ToLower(strings.TrimSpace(query.Reason))
	query.Sort = strings.ToLower(strings.TrimSpace(query.Sort))
	if query.Page < 1 {
		query.Page = 1
	}
	if query.PageSize < 1 || query.PageSize > MaxReviewQueuePageSize {
		query.PageSize = DefaultReviewQueuePageSize
	}
	if query.Sort == "" {
		query.Sort = "oldest"
	}
	return query
}

func (s *Store) CountReviewQueue(ctx context.Context, input ReviewQueueQuery) (int, error) {
	query := NormalizeReviewQueueQuery(input)
	where, args := buildReviewQueueWhere(query)
	var total int
	if err := s.pool.QueryRow(ctx, "SELECT COUNT(*)"+reviewQueueFrom+where, args...).Scan(&total); err != nil {
		return 0, fmt.Errorf("count review queue: %w", err)
	}
	return total, nil
}

func (s *Store) SearchReviewQueue(ctx context.Context, input ReviewQueueQuery) (ReviewQueuePage, error) {
	query := NormalizeReviewQueueQuery(input)
	where, args := buildReviewQueueWhere(query)
	var total int
	if err := s.pool.QueryRow(ctx, "SELECT COUNT(*)"+reviewQueueFrom+where, args...).Scan(&total); err != nil {
		return ReviewQueuePage{}, fmt.Errorf("count review queue: %w", err)
	}

	limitPlaceholder := fmt.Sprintf("$%d", len(args)+1)
	offsetPlaceholder := fmt.Sprintf("$%d", len(args)+2)
	pageArgs := append(append([]any{}, args...), query.PageSize, (query.Page-1)*query.PageSize)
	rows, err := s.pool.Query(ctx, reviewQueueSummarySelect+reviewQueueFrom+where+reviewQueueOrderBy(query.Sort)+" LIMIT "+limitPlaceholder+" OFFSET "+offsetPlaceholder, pageArgs...)
	if err != nil {
		return ReviewQueuePage{}, fmt.Errorf("search review queue: %w", err)
	}
	defer rows.Close()

	items := make([]ReviewQueueSummary, 0, query.PageSize)
	for rows.Next() {
		var item ReviewQueueSummary
		var authorsJSON []byte
		if err := rows.Scan(
			&item.EditionID, &item.WorkID, &item.BookFileID, &item.Title, &item.Format, &item.OriginalFilename,
			&authorsJSON, &item.MetadataPending, &item.CandidateCount, &item.SuggestedClassificationCount, &item.UpdatedAt,
		); err != nil {
			return ReviewQueuePage{}, err
		}
		if err := json.Unmarshal(authorsJSON, &item.Authors); err != nil {
			return ReviewQueuePage{}, err
		}
		if item.Authors == nil {
			item.Authors = []string{}
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return ReviewQueuePage{}, err
	}
	totalPages := 0
	if total > 0 {
		totalPages = (total + query.PageSize - 1) / query.PageSize
	}
	return ReviewQueuePage{Items: items, Total: total, Page: query.Page, PageSize: query.PageSize, TotalPages: totalPages}, nil
}

const reviewQueueSummarySelect = `
	SELECT e.id,w.id,bf.id,w.title,bf.format,bf.original_filename,
		COALESCE((SELECT jsonb_agg(c.name ORDER BY ec.position,c.id)
			FROM edition_creators ec JOIN creators c ON c.id=ec.creator_id
			WHERE ec.edition_id=e.id AND ec.role='author'),'[]'::jsonb),
		w.review_status='pending',
		(SELECT COUNT(*) FROM metadata_candidates mc
			WHERE mc.edition_id=e.id AND mc.status IN ('accepted','suggested')),
		(SELECT COUNT(*) FROM classification_decisions cd
			WHERE cd.edition_id=e.id AND cd.status='suggested'),
		w.updated_at`

const reviewQueueFrom = `
	FROM editions e
	JOIN works w ON w.id=e.work_id
	JOIN LATERAL (
		SELECT id,format,original_filename FROM book_files
		WHERE edition_id=e.id ORDER BY id LIMIT 1
	) bf ON true`

func buildReviewQueueWhere(query ReviewQueueQuery) (string, []any) {
	conditions := []string{`(w.review_status='pending' OR EXISTS(
		SELECT 1 FROM classification_decisions pending_cd
		WHERE pending_cd.edition_id=e.id AND pending_cd.status='suggested'))`}
	args := make([]any, 0, 3)
	addArgument := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	if query.Query != "" {
		placeholder := addArgument(escapeLikePattern(query.Query))
		match := "'%' || " + placeholder + " || '%' ESCAPE E'\\\\'"
		conditions = append(conditions, `(w.title ILIKE `+match+` OR bf.original_filename ILIKE `+match+` OR EXISTS (
			SELECT 1 FROM edition_creators search_ec JOIN creators search_c ON search_c.id=search_ec.creator_id
			WHERE search_ec.edition_id=e.id AND search_ec.role='author' AND search_c.name ILIKE `+match+`))`)
	}
	if query.Format != "" {
		conditions = append(conditions, "bf.format="+addArgument(query.Format))
	}
	switch query.Reason {
	case "metadata":
		conditions = append(conditions, "w.review_status='pending'")
	case "classification":
		conditions = append(conditions, `EXISTS (
			SELECT 1 FROM classification_decisions reason_cd
			WHERE reason_cd.edition_id=e.id AND reason_cd.status='suggested')`)
	}
	return " WHERE " + strings.Join(conditions, " AND "), args
}

func reviewQueueOrderBy(sort string) string {
	switch sort {
	case "title":
		return " ORDER BY w.sort_title,e.id"
	case "newest":
		return " ORDER BY w.updated_at DESC,e.id DESC"
	default:
		return " ORDER BY w.updated_at,e.id"
	}
}
