package store

import (
	"context"
	"fmt"
	"strings"
)

const (
	DefaultCatalogPageSize = 24
	MaxCatalogPageSize     = 100
)

type CatalogQuery struct {
	Query        string
	CategorySlug string
	Format       string
	Status       string
	Sort         string
	Page         int
	PageSize     int
}

type CatalogPage struct {
	Items      []BookFile `json:"items"`
	Total      int        `json:"total"`
	Page       int        `json:"page"`
	PageSize   int        `json:"pageSize"`
	TotalPages int        `json:"totalPages"`
}

func NormalizeCatalogQuery(query CatalogQuery) CatalogQuery {
	query.Query = strings.TrimSpace(query.Query)
	query.CategorySlug = strings.TrimSpace(query.CategorySlug)
	query.Format = strings.ToLower(strings.TrimSpace(query.Format))
	query.Status = strings.ToLower(strings.TrimSpace(query.Status))
	query.Sort = strings.ToLower(strings.TrimSpace(query.Sort))
	if query.Page < 1 {
		query.Page = 1
	}
	if query.PageSize < 1 || query.PageSize > MaxCatalogPageSize {
		query.PageSize = DefaultCatalogPageSize
	}
	if query.Sort == "" {
		query.Sort = "title"
	}
	return query
}

func (s *Store) SearchCatalogBooks(ctx context.Context, userID int64, input CatalogQuery) (CatalogPage, error) {
	query := NormalizeCatalogQuery(input)
	where, args, searchPlaceholder := buildCatalogWhere(userID, query)

	var total int
	if err := s.pool.QueryRow(ctx, "SELECT COUNT(*)"+catalogBookFrom+where, args...).Scan(&total); err != nil {
		return CatalogPage{}, fmt.Errorf("count catalog books: %w", err)
	}

	orderBy := catalogOrderBy(query.Sort, searchPlaceholder)
	limitPlaceholder := fmt.Sprintf("$%d", len(args)+1)
	offsetPlaceholder := fmt.Sprintf("$%d", len(args)+2)
	pageArgs := append(append([]any{}, args...), query.PageSize, (query.Page-1)*query.PageSize)
	rows, err := s.pool.Query(ctx, catalogBookSelect+where+orderBy+" LIMIT "+limitPlaceholder+" OFFSET "+offsetPlaceholder, pageArgs...)
	if err != nil {
		return CatalogPage{}, fmt.Errorf("search catalog books: %w", err)
	}
	defer rows.Close()

	books := make([]BookFile, 0, query.PageSize)
	for rows.Next() {
		book, scanErr := scanCatalogBook(rows)
		if scanErr != nil {
			return CatalogPage{}, scanErr
		}
		books = append(books, book)
	}
	if err := rows.Err(); err != nil {
		return CatalogPage{}, err
	}
	totalPages := 0
	if total > 0 {
		totalPages = (total + query.PageSize - 1) / query.PageSize
	}
	return CatalogPage{Items: books, Total: total, Page: query.Page, PageSize: query.PageSize, TotalPages: totalPages}, nil
}

func buildCatalogWhere(userID int64, query CatalogQuery) (string, []any, string) {
	conditions := make([]string, 0, 4)
	args := make([]any, 0, 6)
	addArgument := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	searchPlaceholder := ""
	if query.Query != "" {
		searchPlaceholder = addArgument(escapeLikePattern(query.Query))
		match := "'%' || " + searchPlaceholder + " || '%' ESCAPE E'\\\\'"
		conditions = append(conditions, `(
			w.title ILIKE `+match+` OR bf.original_filename ILIKE `+match+` OR
			COALESCE(e.isbn,'') ILIKE `+match+` OR COALESCE(e.publisher,'') ILIKE `+match+` OR
			COALESCE(e.published_year::text,'') ILIKE `+match+` OR
			EXISTS (SELECT 1 FROM edition_creators search_ec JOIN creators search_c ON search_c.id=search_ec.creator_id
				WHERE search_ec.edition_id=e.id AND search_ec.role='author' AND search_c.name ILIKE `+match+`) OR
			EXISTS (SELECT 1 FROM classification_decisions search_cd JOIN categories search_cat ON search_cat.id=search_cd.category_id
				WHERE search_cd.edition_id=e.id AND search_cd.status='accepted' AND search_cat.name ILIKE `+match+`)
		)`)
	}
	if query.CategorySlug != "" {
		placeholder := addArgument(query.CategorySlug)
		conditions = append(conditions, `EXISTS (
			SELECT 1 FROM classification_decisions filter_cd JOIN categories filter_cat ON filter_cat.id=filter_cd.category_id
			WHERE filter_cd.edition_id=e.id AND filter_cd.status='accepted' AND filter_cat.slug=`+placeholder+`)`)
	}
	if query.Format != "" {
		conditions = append(conditions, "bf.format="+addArgument(query.Format))
	}
	if query.Status == "unread" {
		conditions = append(conditions, "NOT EXISTS (SELECT 1 FROM reading_states filter_rs WHERE filter_rs.user_id="+addArgument(userID)+" AND filter_rs.book_file_id=bf.id)")
	} else if query.Status != "" {
		userPlaceholder := addArgument(userID)
		statusPlaceholder := addArgument(query.Status)
		conditions = append(conditions, "EXISTS (SELECT 1 FROM reading_states filter_rs WHERE filter_rs.user_id="+userPlaceholder+" AND filter_rs.book_file_id=bf.id AND filter_rs.status="+statusPlaceholder+")")
	}
	if len(conditions) == 0 {
		return "", args, searchPlaceholder
	}
	return " WHERE " + strings.Join(conditions, " AND "), args, searchPlaceholder
}

func catalogOrderBy(sort string, searchPlaceholder string) string {
	switch sort {
	case "newest":
		return " ORDER BY bf.created_at DESC,bf.id DESC"
	case "hot":
		return ` ORDER BY COALESCE((
			SELECT SUM(hot_rs.active_seconds * CASE WHEN hot_rs.started_at >= now()-INTERVAL '7 days' THEN 1.0 ELSE 0.45 END)
				+ COUNT(*) * 30 + COUNT(DISTINCT hot_rs.user_id) * 300
			FROM reading_sessions hot_rs
			WHERE hot_rs.book_file_id=bf.id AND hot_rs.started_at >= now()-INTERVAL '30 days'
		),0) DESC,w.sort_title,bf.id`
	case "relevance":
		if searchPlaceholder != "" {
			return " ORDER BY CASE WHEN lower(w.title)=lower(" + searchPlaceholder + ") THEN 0 WHEN w.title ILIKE " + searchPlaceholder + " || '%' ESCAPE E'\\\\' THEN 1 ELSE 2 END,w.sort_title,bf.id"
		}
	}
	return " ORDER BY w.sort_title,bf.id"
}

func escapeLikePattern(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}
