package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// DeleteBookFile removes one catalogue file and its dependent, user-specific
// records. The caller is responsible for handling application-owned bytes
// before calling this method; external source files must never be removed here.
func (s *Store) DeleteBookFile(ctx context.Context, bookFileID int64) (BookFile, bool, error) {
	if bookFileID <= 0 {
		return BookFile{}, false, errors.New("book file ID must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BookFile{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	book, err := scanCatalogBook(tx.QueryRow(ctx, catalogBookSelect+" WHERE bf.id=$1 FOR UPDATE", bookFileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return BookFile{}, false, nil
	}
	if err != nil {
		return BookFile{}, false, fmt.Errorf("load book file for deletion: %w", err)
	}
	if _, err := tx.Exec(ctx, "DELETE FROM book_files WHERE id=$1", bookFileID); err != nil {
		return BookFile{}, false, fmt.Errorf("delete book file: %w", err)
	}
	// A file can share an edition with another format. Only remove the edition
	// and work when they no longer describe any remaining book file.
	if _, err := tx.Exec(ctx, `DELETE FROM editions e
		WHERE e.id=$1 AND NOT EXISTS(SELECT 1 FROM book_files bf WHERE bf.edition_id=e.id)`, book.EditionID); err != nil {
		return BookFile{}, false, fmt.Errorf("remove empty edition: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM works w
		WHERE w.id=$1 AND NOT EXISTS(SELECT 1 FROM editions e WHERE e.work_id=w.id)`, book.WorkID); err != nil {
		return BookFile{}, false, fmt.Errorf("remove empty work: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return BookFile{}, false, err
	}
	return book, true, nil
}
