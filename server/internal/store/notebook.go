package store

import (
	"context"
	"fmt"
)

type NotebookQuery struct {
	Query, Kind, Color string
	BookFileID         int64
	Page, PageSize     int
}

type NotebookEntry struct {
	ReadingMark
	BookTitle  string `json:"bookTitle"`
	BookFormat string `json:"bookFormat"`
}

type NotebookPage struct {
	Items      []NotebookEntry `json:"items"`
	Total      int             `json:"total"`
	Page       int             `json:"page"`
	PageSize   int             `json:"pageSize"`
	TotalPages int             `json:"totalPages"`
}

func (s *Store) SearchNotebook(ctx context.Context, userID int64, query NotebookQuery) (NotebookPage, error) {
	paging := NormalizeCatalogQuery(CatalogQuery{Page: query.Page, PageSize: query.PageSize})
	args := []any{userID}
	from := ` FROM reading_marks rm
        JOIN accessible_book_ids($1) accessible ON accessible.book_file_id=rm.book_file_id
        JOIN book_files bf ON bf.id=rm.book_file_id
        JOIN editions e ON e.id=bf.edition_id JOIN works w ON w.id=e.work_id
        WHERE rm.user_id=$1`
	add := func(value any) string { args = append(args, value); return fmt.Sprintf("$%d", len(args)) }
	if query.Query != "" {
		p := add("%" + escapeLikePattern(query.Query) + "%")
		from += ` AND (rm.label ILIKE ` + p + ` ESCAPE E'\\' OR rm.body ILIKE ` + p + ` ESCAPE E'\\' OR rm.quote ILIKE ` + p + ` ESCAPE E'\\' OR w.title ILIKE ` + p + ` ESCAPE E'\\')`
	}
	if query.Kind != "" {
		from += " AND rm.kind=" + add(query.Kind)
	}
	if query.Color != "" {
		from += " AND rm.color=" + add(query.Color)
	}
	if query.BookFileID > 0 {
		from += " AND rm.book_file_id=" + add(query.BookFileID)
	}
	result := NotebookPage{Items: make([]NotebookEntry, 0), Page: paging.Page, PageSize: paging.PageSize}
	if err := s.pool.QueryRow(ctx, "SELECT COUNT(*)"+from, args...).Scan(&result.Total); err != nil {
		return result, err
	}
	limit, offset := add(paging.PageSize), add((paging.Page-1)*paging.PageSize)
	rows, err := s.pool.Query(ctx, `SELECT rm.id,rm.book_file_id,rm.kind,rm.position,rm.overall_progress,rm.label,rm.body,rm.quote,rm.color,rm.created_at,rm.updated_at,w.title,bf.format`+from+` ORDER BY rm.updated_at DESC,rm.id DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var item NotebookEntry
		err := rows.Scan(&item.ID, &item.BookFileID, &item.Kind, &item.Position, &item.OverallProgress, &item.Label, &item.Body, &item.Quote, &item.Color, &item.CreatedAt, &item.UpdatedAt, &item.BookTitle, &item.BookFormat)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, item)
	}
	result.TotalPages = (result.Total + paging.PageSize - 1) / paging.PageSize
	return result, rows.Err()
}
