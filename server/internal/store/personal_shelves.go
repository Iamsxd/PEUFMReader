package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

type PersonalShelf struct {
	ID           int64     `json:"id"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	BookCount    int       `json:"bookCount"`
	ContainsBook bool      `json:"containsBook"`
	CreatedAt    time.Time `json:"createdAt"`
}

func (s *Store) ListPersonalShelves(ctx context.Context, userID, bookID int64) ([]PersonalShelf, error) {
	rows, err := s.pool.Query(ctx, `WITH allowed AS MATERIALIZED (SELECT book_file_id FROM accessible_book_ids($1))
        SELECT ps.id,ps.name,ps.description,ps.created_at,
        (SELECT COUNT(*) FROM personal_shelf_books sb JOIN allowed a USING(book_file_id) WHERE sb.shelf_id=ps.id),
        EXISTS(SELECT 1 FROM personal_shelf_books sb JOIN allowed a USING(book_file_id) WHERE sb.shelf_id=ps.id AND sb.book_file_id=$2)
        FROM personal_shelves ps WHERE ps.user_id=$1 ORDER BY ps.created_at,ps.id`, userID, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]PersonalShelf, 0)
	for rows.Next() {
		var item PersonalShelf
		if err := rows.Scan(&item.ID, &item.Name, &item.Description, &item.CreatedAt, &item.BookCount, &item.ContainsBook); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) SavePersonalShelf(ctx context.Context, userID, id int64, name, description string) (PersonalShelf, bool, error) {
	var shelf PersonalShelf
	var err error
	if id == 0 {
		err = s.pool.QueryRow(ctx, `INSERT INTO personal_shelves(user_id,name,description) VALUES($1,$2,$3) RETURNING id,name,description,created_at`, userID, name, description).Scan(&shelf.ID, &shelf.Name, &shelf.Description, &shelf.CreatedAt)
	} else {
		err = s.pool.QueryRow(ctx, `UPDATE personal_shelves SET name=$3,description=$4 WHERE id=$2 AND user_id=$1 RETURNING id,name,description,created_at`, userID, id, name, description).Scan(&shelf.ID, &shelf.Name, &shelf.Description, &shelf.CreatedAt)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return shelf, false, nil
	}
	return shelf, err == nil, err
}

func (s *Store) DeletePersonalShelf(ctx context.Context, userID, id int64) (bool, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM personal_shelves WHERE id=$2 AND user_id=$1`, userID, id)
	return tag.RowsAffected() > 0, err
}

func (s *Store) PersonalShelfExists(ctx context.Context, userID, id int64) (bool, error) {
	var found bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM personal_shelves WHERE user_id=$1 AND id=$2)`, userID, id).Scan(&found)
	return found, err
}

func (s *Store) PersonalShelfBooks(ctx context.Context, userID, id int64, page, pageSize int) (CatalogPage, error) {
	paging := NormalizeCatalogQuery(CatalogQuery{Page: page, PageSize: pageSize})
	result := CatalogPage{Items: make([]BookFile, 0), Page: paging.Page, PageSize: paging.PageSize}
	join := ` JOIN personal_shelf_books sb ON sb.book_file_id=bf.id JOIN personal_shelves ps ON ps.id=sb.shelf_id WHERE ps.user_id=$1 AND ps.id=$2`
	if err := s.pool.QueryRow(ctx, "SELECT COUNT(*)"+catalogAccessibleBookFrom+join, userID, id).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := s.pool.Query(ctx, catalogAccessibleBookSelect+join+` ORDER BY sb.position,bf.id LIMIT $3 OFFSET $4`, userID, id, paging.PageSize, (paging.Page-1)*paging.PageSize)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		book, err := scanCatalogBook(rows)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, book)
	}
	result.TotalPages = (result.Total + paging.PageSize - 1) / paging.PageSize
	return result, rows.Err()
}

// Serializing changes on the parent row makes append and move deterministic,
// including when two devices edit the same reading list concurrently.
func (s *Store) ChangePersonalShelfBook(ctx context.Context, userID, id, bookID int64, action string) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var lockedID int64
	err = tx.QueryRow(ctx, `SELECT id FROM personal_shelves WHERE user_id=$1 AND id=$2 FOR UPDATE`, userID, id).Scan(&lockedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	switch action {
	case "add":
		tag, writeErr := tx.Exec(ctx, `INSERT INTO personal_shelf_books(shelf_id,book_file_id,position)
            SELECT $2,$3,COALESCE((SELECT MAX(position) FROM personal_shelf_books WHERE shelf_id=$2),0)+1
            WHERE EXISTS(SELECT 1 FROM accessible_book_ids($1) WHERE book_file_id=$3)
            ON CONFLICT(shelf_id,book_file_id) DO NOTHING`, userID, id, bookID)
		if writeErr != nil {
			return false, writeErr
		}
		if tag.RowsAffected() == 0 {
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM personal_shelf_books WHERE shelf_id=$1 AND book_file_id=$2)`, id, bookID).Scan(&exists); err != nil {
				return false, err
			}
			if !exists {
				return false, nil
			}
		}
	case "remove":
		if _, err = tx.Exec(ctx, `DELETE FROM personal_shelf_books WHERE shelf_id=$1 AND book_file_id=$2`, id, bookID); err != nil {
			return false, err
		}
	case "earlier", "later":
		var current int64
		err = tx.QueryRow(ctx, `SELECT position FROM personal_shelf_books WHERE shelf_id=$1 AND book_file_id=$2`, id, bookID).Scan(&current)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		comparison, order := "<", "DESC"
		if action == "later" {
			comparison, order = ">", "ASC"
		}
		var neighborID, neighborPosition int64
		err = tx.QueryRow(ctx, `SELECT sb.book_file_id,sb.position FROM personal_shelf_books sb
            JOIN accessible_book_ids($1) a USING(book_file_id)
            WHERE sb.shelf_id=$2 AND sb.position `+comparison+` $3 ORDER BY sb.position `+order+` LIMIT 1`, userID, id, current).Scan(&neighborID, &neighborPosition)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE personal_shelf_books SET position=CASE WHEN book_file_id=$2 THEN $4::bigint ELSE $5::bigint END WHERE shelf_id=$1 AND book_file_id IN ($2,$3)`, id, bookID, neighborID, neighborPosition, current)
			if err != nil {
				return false, err
			}
		}
	default:
		return false, fmt.Errorf("invalid shelf action: %s", action)
	}
	return true, tx.Commit(ctx)
}
