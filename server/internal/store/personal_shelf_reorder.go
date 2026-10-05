package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ReorderPersonalShelfBook moves one member relative to another, never accepting
// a client-provided full list. Hidden members and members on other pages remain
// in the list, and every member other than bookID retains its relative order.
func (s *Store) ReorderPersonalShelfBook(ctx context.Context, userID, id, bookID, targetBookID int64, placement string) (bool, error) {
	if bookID <= 0 || targetBookID <= 0 || bookID == targetBookID || (placement != "before" && placement != "after") {
		return false, fmt.Errorf("invalid personal shelf move")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var lockedID int64
	err = tx.QueryRow(ctx, `SELECT id FROM personal_shelves WHERE user_id=$1 AND id=$2 AND kind='manual' FOR UPDATE`, userID, id).Scan(&lockedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var valid bool
	err = tx.QueryRow(ctx, `WITH members AS MATERIALIZED (
            SELECT book_file_id,ROW_NUMBER() OVER(ORDER BY position,book_file_id) AS ordinal
            FROM personal_shelf_books WHERE shelf_id=$2
        ), validated AS MATERIALIZED (
            SELECT COUNT(*)=2 AS can_move FROM members JOIN accessible_book_ids($1) allowed USING(book_file_id)
            WHERE book_file_id IN ($3,$4)
        ), target AS (SELECT ordinal FROM members WHERE book_file_id=$4), reordered AS (
            SELECT members.book_file_id,ROW_NUMBER() OVER(ORDER BY
                CASE WHEN members.book_file_id=$3 THEN target.ordinal*2+CASE WHEN $5='before' THEN -1 ELSE 1 END
                    ELSE members.ordinal*2 END,members.book_file_id) AS position
            FROM members CROSS JOIN target
        ), updated AS (
            UPDATE personal_shelf_books sb SET position=reordered.position
            FROM reordered,validated WHERE validated.can_move AND sb.shelf_id=$2
                AND sb.book_file_id=reordered.book_file_id AND sb.position IS DISTINCT FROM reordered.position
            RETURNING sb.book_file_id
        ) SELECT can_move FROM validated`, userID, id, bookID, targetBookID, placement).Scan(&valid)
	if err != nil {
		return false, err
	}
	if !valid {
		return false, nil
	}
	return true, tx.Commit(ctx)
}
