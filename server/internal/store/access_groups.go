package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var ErrAccessGroupNameConflict = errors.New("access group name already exists")

type UserGroup struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	MemberIDs   []int64   `json:"memberIds"`
	MemberCount int       `json:"memberCount"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type LibraryGroup struct {
	ID            int64     `json:"id"`
	Name          string    `json:"name"`
	Description   string    `json:"description"`
	DefaultAccess bool      `json:"defaultAccess"`
	BookFileIDs   []int64   `json:"bookFileIds"`
	BookCount     int       `json:"bookCount"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type GroupLibraryPermission struct {
	UserGroupID    int64     `json:"userGroupId"`
	LibraryGroupID int64     `json:"libraryGroupId"`
	CanRead        bool      `json:"canRead"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

const userGroupSelect = `
	SELECT access_group.id,access_group.name,access_group.description,
		COALESCE(array_agg(member.user_id ORDER BY member.user_id) FILTER (WHERE member.user_id IS NOT NULL),'{}'::bigint[]),
		count(member.user_id)::int,access_group.created_at,access_group.updated_at
	FROM user_groups access_group
	LEFT JOIN user_group_members member ON member.user_group_id=access_group.id`

func (s *Store) ListUserGroups(ctx context.Context) ([]UserGroup, error) {
	rows, err := s.pool.Query(ctx, userGroupSelect+`
		GROUP BY access_group.id ORDER BY lower(access_group.name),access_group.id`)
	if err != nil {
		return nil, fmt.Errorf("list user groups: %w", err)
	}
	defer rows.Close()
	items := make([]UserGroup, 0)
	for rows.Next() {
		item, err := scanUserGroup(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) GetUserGroup(ctx context.Context, id int64) (UserGroup, bool, error) {
	item, err := scanUserGroup(s.pool.QueryRow(ctx, userGroupSelect+`
		WHERE access_group.id=$1 GROUP BY access_group.id`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return UserGroup{}, false, nil
	}
	if err != nil {
		return UserGroup{}, false, fmt.Errorf("get user group: %w", err)
	}
	return item, true, nil
}

func (s *Store) CreateUserGroup(ctx context.Context, name, description string) (UserGroup, error) {
	var id int64
	err := s.pool.QueryRow(ctx, `INSERT INTO user_groups(name,description) VALUES ($1,$2) RETURNING id`,
		strings.TrimSpace(name), strings.TrimSpace(description)).Scan(&id)
	if err != nil {
		return UserGroup{}, accessGroupWriteError("create user group", err)
	}
	item, _, err := s.GetUserGroup(ctx, id)
	return item, err
}

func (s *Store) UpdateUserGroup(ctx context.Context, id int64, name, description string) (UserGroup, bool, error) {
	result, err := s.pool.Exec(ctx, `UPDATE user_groups SET name=$2,description=$3,updated_at=now() WHERE id=$1`,
		id, strings.TrimSpace(name), strings.TrimSpace(description))
	if err != nil {
		return UserGroup{}, false, accessGroupWriteError("update user group", err)
	}
	if result.RowsAffected() == 0 {
		return UserGroup{}, false, nil
	}
	item, _, err := s.GetUserGroup(ctx, id)
	return item, true, err
}

func (s *Store) DeleteUserGroup(ctx context.Context, id int64) (bool, error) {
	result, err := s.pool.Exec(ctx, `DELETE FROM user_groups WHERE id=$1`, id)
	if err != nil {
		return false, fmt.Errorf("delete user group: %w", err)
	}
	return result.RowsAffected() > 0, nil
}

func (s *Store) SetUserGroupMember(ctx context.Context, groupID, userID int64, member bool) error {
	if member {
		_, err := s.pool.Exec(ctx, `INSERT INTO user_group_members(user_group_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, groupID, userID)
		return wrapStoreError("add user group member", err)
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM user_group_members WHERE user_group_id=$1 AND user_id=$2`, groupID, userID)
	return wrapStoreError("remove user group member", err)
}

const libraryGroupSelect = `
	SELECT library_group.id,library_group.name,library_group.description,library_group.default_access,
		COALESCE(array_agg(member.book_file_id ORDER BY member.book_file_id) FILTER (WHERE member.book_file_id IS NOT NULL),'{}'::bigint[]),
		count(member.book_file_id)::int,library_group.created_at,library_group.updated_at
	FROM library_groups library_group
	LEFT JOIN library_group_books member ON member.library_group_id=library_group.id`

func (s *Store) ListLibraryGroups(ctx context.Context) ([]LibraryGroup, error) {
	rows, err := s.pool.Query(ctx, libraryGroupSelect+`
		GROUP BY library_group.id ORDER BY lower(library_group.name),library_group.id`)
	if err != nil {
		return nil, fmt.Errorf("list library groups: %w", err)
	}
	defer rows.Close()
	items := make([]LibraryGroup, 0)
	for rows.Next() {
		item, err := scanLibraryGroup(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) GetLibraryGroup(ctx context.Context, id int64) (LibraryGroup, bool, error) {
	item, err := scanLibraryGroup(s.pool.QueryRow(ctx, libraryGroupSelect+`
		WHERE library_group.id=$1 GROUP BY library_group.id`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return LibraryGroup{}, false, nil
	}
	if err != nil {
		return LibraryGroup{}, false, fmt.Errorf("get library group: %w", err)
	}
	return item, true, nil
}

func (s *Store) CreateLibraryGroup(ctx context.Context, name, description string, defaultAccess bool) (LibraryGroup, error) {
	var id int64
	err := s.pool.QueryRow(ctx, `INSERT INTO library_groups(name,description,default_access) VALUES ($1,$2,$3) RETURNING id`,
		strings.TrimSpace(name), strings.TrimSpace(description), defaultAccess).Scan(&id)
	if err != nil {
		return LibraryGroup{}, accessGroupWriteError("create library group", err)
	}
	item, _, err := s.GetLibraryGroup(ctx, id)
	return item, err
}

func (s *Store) UpdateLibraryGroup(ctx context.Context, id int64, name, description string, defaultAccess bool) (LibraryGroup, bool, error) {
	result, err := s.pool.Exec(ctx, `UPDATE library_groups SET name=$2,description=$3,default_access=$4,updated_at=now() WHERE id=$1`,
		id, strings.TrimSpace(name), strings.TrimSpace(description), defaultAccess)
	if err != nil {
		return LibraryGroup{}, false, accessGroupWriteError("update library group", err)
	}
	if result.RowsAffected() == 0 {
		return LibraryGroup{}, false, nil
	}
	item, _, err := s.GetLibraryGroup(ctx, id)
	return item, true, err
}

func (s *Store) DeleteLibraryGroup(ctx context.Context, id int64) (bool, error) {
	result, err := s.pool.Exec(ctx, `DELETE FROM library_groups WHERE id=$1`, id)
	if err != nil {
		return false, fmt.Errorf("delete library group: %w", err)
	}
	return result.RowsAffected() > 0, nil
}

func (s *Store) SetLibraryGroupBook(ctx context.Context, groupID, bookFileID int64, member bool) error {
	if member {
		_, err := s.pool.Exec(ctx, `INSERT INTO library_group_books(library_group_id,book_file_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, groupID, bookFileID)
		return wrapStoreError("add library group book", err)
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM library_group_books WHERE library_group_id=$1 AND book_file_id=$2`, groupID, bookFileID)
	return wrapStoreError("remove library group book", err)
}

func (s *Store) ListGroupLibraryPermissions(ctx context.Context) ([]GroupLibraryPermission, error) {
	rows, err := s.pool.Query(ctx, `SELECT user_group_id,library_group_id,can_read,updated_at
		FROM user_group_library_permissions ORDER BY user_group_id,library_group_id`)
	if err != nil {
		return nil, fmt.Errorf("list group library permissions: %w", err)
	}
	defer rows.Close()
	items := make([]GroupLibraryPermission, 0)
	for rows.Next() {
		var item GroupLibraryPermission
		if err := rows.Scan(&item.UserGroupID, &item.LibraryGroupID, &item.CanRead, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) SetGroupLibraryPermission(ctx context.Context, userGroupID, libraryGroupID int64, canRead bool) (GroupLibraryPermission, error) {
	var item GroupLibraryPermission
	err := s.pool.QueryRow(ctx, `
		INSERT INTO user_group_library_permissions(user_group_id,library_group_id,can_read)
		VALUES ($1,$2,$3)
		ON CONFLICT (user_group_id,library_group_id) DO UPDATE SET can_read=EXCLUDED.can_read,updated_at=now()
		RETURNING user_group_id,library_group_id,can_read,updated_at`, userGroupID, libraryGroupID, canRead,
	).Scan(&item.UserGroupID, &item.LibraryGroupID, &item.CanRead, &item.UpdatedAt)
	if err != nil {
		return GroupLibraryPermission{}, fmt.Errorf("set group library permission: %w", err)
	}
	return item, nil
}

func (s *Store) DeleteGroupLibraryPermission(ctx context.Context, userGroupID, libraryGroupID int64) (bool, error) {
	result, err := s.pool.Exec(ctx, `DELETE FROM user_group_library_permissions WHERE user_group_id=$1 AND library_group_id=$2`, userGroupID, libraryGroupID)
	if err != nil {
		return false, fmt.Errorf("delete group library permission: %w", err)
	}
	return result.RowsAffected() > 0, nil
}

type groupScanner interface {
	Scan(dest ...any) error
}

func scanUserGroup(scanner groupScanner) (UserGroup, error) {
	var item UserGroup
	err := scanner.Scan(&item.ID, &item.Name, &item.Description, &item.MemberIDs, &item.MemberCount, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func scanLibraryGroup(scanner groupScanner) (LibraryGroup, error) {
	var item LibraryGroup
	err := scanner.Scan(&item.ID, &item.Name, &item.Description, &item.DefaultAccess, &item.BookFileIDs, &item.BookCount, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func accessGroupWriteError(operation string, err error) error {
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) && databaseError.Code == "23505" {
		return ErrAccessGroupNameConflict
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func wrapStoreError(operation string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", operation, err)
}
