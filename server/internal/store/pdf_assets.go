package store

import (
	"context"
	"fmt"
)

func (s *Store) UpdatePDFAssets(ctx context.Context, bookFileID int64, coverPath, textPath, method string, pageCount int) error {
	command, err := s.pool.Exec(ctx, `
		UPDATE book_files SET
			cover_path=COALESCE(NULLIF($1,''),cover_path),
			extracted_text_path=COALESCE(NULLIF($2,''),extracted_text_path),
			text_extraction_method=COALESCE(NULLIF($3,''),text_extraction_method),
			page_count=CASE WHEN $4 > 0 THEN $4 ELSE page_count END,
			assets_updated_at=now()
		WHERE id=$5 AND format='pdf'`, coverPath, textPath, method, pageCount, bookFileID)
	if err != nil {
		return fmt.Errorf("update PDF assets: %w", err)
	}
	if command.RowsAffected() == 0 {
		return fmt.Errorf("PDF book file %d not found", bookFileID)
	}
	return nil
}

func (s *Store) UpdatePDFCover(ctx context.Context, bookFileID int64, coverPath string) error {
	command, err := s.pool.Exec(ctx, `
		UPDATE book_files SET cover_path=NULLIF($1,''),assets_updated_at=now()
		WHERE id=$2 AND format='pdf'`, coverPath, bookFileID)
	if err != nil {
		return fmt.Errorf("update PDF cover: %w", err)
	}
	if command.RowsAffected() == 0 {
		return fmt.Errorf("PDF book file %d not found", bookFileID)
	}
	return nil
}

func (s *Store) ListPDFsMissingAssets(ctx context.Context, limit int) ([]int64, error) {
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id FROM book_files
		WHERE format='pdf' AND assets_updated_at IS NULL
		ORDER BY id LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
