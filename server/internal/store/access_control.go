package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type BookPermission struct {
	UserID     int64     `json:"userId"`
	BookFileID int64     `json:"bookFileId"`
	Title      string    `json:"title"`
	CanRead    bool      `json:"canRead"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

func (s *Store) UpsertExternalUser(ctx context.Context, source, subject, username, role string) (User, error) {
	source = strings.ToLower(strings.TrimSpace(source))
	subject = strings.TrimSpace(subject)
	username = strings.ToLower(strings.TrimSpace(username))
	if (source != "oidc" && source != "ldap") || subject == "" || username == "" || (role != "admin" && role != "reader") {
		return User{}, fmt.Errorf("invalid external identity")
	}
	var user User
	var disabled bool
	err := s.pool.QueryRow(ctx, `
		SELECT id,username,role,auth_source,disabled_at IS NOT NULL
		FROM users WHERE auth_source=$1 AND external_subject=$2`, source, subject,
	).Scan(&user.ID, &user.Username, &user.Role, &user.AuthSource, &disabled)
	if err == nil {
		if disabled {
			return User{}, ErrExternalUserDisabled
		}
		err = s.pool.QueryRow(ctx, `
			UPDATE users SET role=$2 WHERE id=$1
			RETURNING id,username,role,auth_source`, user.ID, role,
		).Scan(&user.ID, &user.Username, &user.Role, &user.AuthSource)
		return user, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return User{}, fmt.Errorf("load external identity: %w", err)
	}
	err = s.pool.QueryRow(ctx, `
		INSERT INTO users(username,password_hash,role,auth_source,external_subject)
		VALUES ($1,NULL,$2,$3,$4)
		ON CONFLICT (username) DO NOTHING
		RETURNING id,username,role,auth_source`, username, role, source, subject,
	).Scan(&user.ID, &user.Username, &user.Role, &user.AuthSource)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrExternalIdentityConflict
	}
	if err != nil {
		return User{}, fmt.Errorf("create external user: %w", err)
	}
	return user, nil
}

func (s *Store) CanAccessBook(ctx context.Context, userID, bookFileID int64) (bool, bool, error) {
	var allowed bool
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(can_user_read_book($1,$2),false)
		FROM book_files WHERE id=$2`, userID, bookFileID,
	).Scan(&allowed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("check book access: %w", err)
	}
	return allowed, true, nil
}

func (s *Store) FilterAccessibleBookIDs(ctx context.Context, userID int64, bookFileIDs []int64) (map[int64]bool, error) {
	allowed := make(map[int64]bool)
	if len(bookFileIDs) == 0 {
		return allowed, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT requested.book_file_id
		FROM unnest($2::bigint[]) WITH ORDINALITY requested(book_file_id,position)
		JOIN book_files bf ON bf.id=requested.book_file_id
		WHERE can_user_read_book($1,bf.id)
		ORDER BY requested.position`, userID, bookFileIDs)
	if err != nil {
		return nil, fmt.Errorf("filter accessible books: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		allowed[id] = true
	}
	return allowed, rows.Err()
}

func (s *Store) ListBookPermissions(ctx context.Context, userID int64) ([]BookPermission, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.user_id,p.book_file_id,w.title,p.can_read,p.updated_at
		FROM book_file_permissions p
		JOIN book_files bf ON bf.id=p.book_file_id
		JOIN editions e ON e.id=bf.edition_id
		JOIN works w ON w.id=e.work_id
		WHERE p.user_id=$1 ORDER BY w.sort_title,bf.id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list book permissions: %w", err)
	}
	defer rows.Close()
	items := make([]BookPermission, 0)
	for rows.Next() {
		var item BookPermission
		if err := rows.Scan(&item.UserID, &item.BookFileID, &item.Title, &item.CanRead, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) SetBookPermission(ctx context.Context, userID, bookFileID int64, canRead bool) (BookPermission, error) {
	var item BookPermission
	err := s.pool.QueryRow(ctx, `
		INSERT INTO book_file_permissions(user_id,book_file_id,can_read)
		VALUES ($1,$2,$3)
		ON CONFLICT (user_id,book_file_id) DO UPDATE SET can_read=EXCLUDED.can_read,updated_at=now()
		RETURNING user_id,book_file_id,can_read,updated_at`, userID, bookFileID, canRead,
	).Scan(&item.UserID, &item.BookFileID, &item.CanRead, &item.UpdatedAt)
	if err != nil {
		return BookPermission{}, fmt.Errorf("set book permission: %w", err)
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT w.title FROM book_files bf JOIN editions e ON e.id=bf.edition_id JOIN works w ON w.id=e.work_id WHERE bf.id=$1`, bookFileID,
	).Scan(&item.Title); err != nil {
		return BookPermission{}, fmt.Errorf("load permission book: %w", err)
	}
	return item, nil
}

func (s *Store) DeleteBookPermission(ctx context.Context, userID, bookFileID int64) (bool, error) {
	result, err := s.pool.Exec(ctx, "DELETE FROM book_file_permissions WHERE user_id=$1 AND book_file_id=$2", userID, bookFileID)
	if err != nil {
		return false, fmt.Errorf("delete book permission: %w", err)
	}
	return result.RowsAffected() > 0, nil
}
