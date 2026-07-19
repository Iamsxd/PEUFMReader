package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"peufmreader/internal/auth"
)

var (
	ErrUserNotFound    = errors.New("user not found")
	ErrLastActiveAdmin = errors.New("cannot remove the last active administrator")
)

type ManagedUser struct {
	ID                 int64      `json:"id"`
	Username           string     `json:"username"`
	Role               string     `json:"role"`
	CreatedAt          time.Time  `json:"createdAt"`
	DisabledAt         *time.Time `json:"disabledAt,omitempty"`
	LastLoginAt        *time.Time `json:"lastLoginAt,omitempty"`
	LastLoginIP        string     `json:"lastLoginIp"`
	LastSeenAt         *time.Time `json:"lastSeenAt,omitempty"`
	ActiveSessionCount int64      `json:"activeSessionCount"`
	ReadingBookCount   int64      `json:"readingBookCount"`
	TotalActiveSeconds int64      `json:"totalActiveSeconds"`
}

type UserSessionInfo struct {
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	ClientIP   string    `json:"clientIp"`
	UserAgent  string    `json:"userAgent"`
	Current    bool      `json:"current"`
}

type UserLoginEvent struct {
	CreatedAt  time.Time `json:"createdAt"`
	ClientIP   string    `json:"clientIp"`
	StatusCode int       `json:"statusCode"`
}

type UserAccessInfo struct {
	Sessions     []UserSessionInfo `json:"sessions"`
	RecentLogins []UserLoginEvent  `json:"recentLogins"`
}

const managedUserSelect = `
	SELECT u.id,u.username,u.role,u.created_at,u.disabled_at,
		login.created_at,COALESCE(login.client_ip,''),sessions.last_seen_at,
		COALESCE(sessions.active_count,0),
		COALESCE(reading.book_count,0),COALESCE(reading.active_seconds,0)
	FROM users u
	LEFT JOIN LATERAL (
		SELECT ae.created_at,ae.client_ip
		FROM audit_events ae
		WHERE ae.actor_id=u.id AND ae.action='auth.login.succeeded'
		ORDER BY ae.created_at DESC,ae.id DESC LIMIT 1
	) login ON true
	LEFT JOIN LATERAL (
		SELECT max(us.last_seen_at) AS last_seen_at,
			count(*) FILTER (WHERE us.expires_at > now()) AS active_count
		FROM user_sessions us WHERE us.user_id=u.id
	) sessions ON true
	LEFT JOIN LATERAL (
		SELECT count(*) FILTER (WHERE rs.status <> 'unread') AS book_count,
			COALESCE(sum(rs.total_active_seconds),0) AS active_seconds
		FROM reading_states rs WHERE rs.user_id=u.id
	) reading ON true`

type userScanner interface {
	Scan(dest ...any) error
}

func scanManagedUser(row userScanner) (ManagedUser, error) {
	var user ManagedUser
	err := row.Scan(
		&user.ID, &user.Username, &user.Role, &user.CreatedAt, &user.DisabledAt,
		&user.LastLoginAt, &user.LastLoginIP, &user.LastSeenAt,
		&user.ActiveSessionCount, &user.ReadingBookCount, &user.TotalActiveSeconds,
	)
	return user, err
}

func (s *Store) ListManagedUsers(ctx context.Context) ([]ManagedUser, error) {
	rows, err := s.pool.Query(ctx, managedUserSelect+" ORDER BY (u.disabled_at IS NOT NULL),u.username")
	if err != nil {
		return nil, fmt.Errorf("list managed users: %w", err)
	}
	defer rows.Close()
	users := make([]ManagedUser, 0)
	for rows.Next() {
		user, err := scanManagedUser(rows)
		if err != nil {
			return nil, fmt.Errorf("scan managed user: %w", err)
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (s *Store) GetManagedUser(ctx context.Context, userID int64) (ManagedUser, bool, error) {
	user, err := scanManagedUser(s.pool.QueryRow(ctx, managedUserSelect+" WHERE u.id=$1", userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ManagedUser{}, false, nil
	}
	if err != nil {
		return ManagedUser{}, false, fmt.Errorf("get managed user: %w", err)
	}
	return user, true, nil
}

func (s *Store) UpdateManagedUser(ctx context.Context, userID int64, username, role string, disabled bool) (ManagedUser, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	if username == "" || (role != "admin" && role != "reader") {
		return ManagedUser{}, fmt.Errorf("invalid username or role")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ManagedUser{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", int64(20260720)); err != nil {
		return ManagedUser{}, err
	}
	var currentRole string
	var currentlyDisabled bool
	err = tx.QueryRow(ctx, "SELECT role,disabled_at IS NOT NULL FROM users WHERE id=$1 FOR UPDATE", userID).Scan(&currentRole, &currentlyDisabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return ManagedUser{}, ErrUserNotFound
	}
	if err != nil {
		return ManagedUser{}, err
	}
	if currentRole == "admin" && !currentlyDisabled && (role != "admin" || disabled) {
		var activeAdmins int64
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM users WHERE role='admin' AND disabled_at IS NULL").Scan(&activeAdmins); err != nil {
			return ManagedUser{}, err
		}
		if activeAdmins <= 1 {
			return ManagedUser{}, ErrLastActiveAdmin
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE users SET username=$2,role=$3,
			disabled_at=CASE WHEN $4 THEN COALESCE(disabled_at,now()) ELSE NULL END
		WHERE id=$1`, userID, username, role, disabled); err != nil {
		return ManagedUser{}, fmt.Errorf("update user: %w", err)
	}
	if disabled {
		if _, err := tx.Exec(ctx, "DELETE FROM user_sessions WHERE user_id=$1", userID); err != nil {
			return ManagedUser{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ManagedUser{}, err
	}
	user, found, err := s.GetManagedUser(ctx, userID)
	if err != nil {
		return ManagedUser{}, err
	}
	if !found {
		return ManagedUser{}, ErrUserNotFound
	}
	return user, nil
}

func (s *Store) ResetUserPassword(ctx context.Context, userID int64, password string) error {
	passwordHash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := tx.Exec(ctx, "UPDATE users SET password_hash=$2 WHERE id=$1", userID, passwordHash)
	if err != nil {
		return fmt.Errorf("reset user password: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrUserNotFound
	}
	if _, err := tx.Exec(ctx, "DELETE FROM user_sessions WHERE user_id=$1", userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RevokeUserSessions(ctx context.Context, userID int64) error {
	result, err := s.pool.Exec(ctx, `
		DELETE FROM user_sessions
		WHERE user_id=$1 AND EXISTS (SELECT 1 FROM users WHERE id=$1)`, userID)
	if err != nil {
		return fmt.Errorf("revoke user sessions: %w", err)
	}
	if result.RowsAffected() == 0 {
		var exists bool
		if err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)", userID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrUserNotFound
		}
	}
	return nil
}

func (s *Store) DeleteManagedUser(ctx context.Context, userID int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", int64(20260720)); err != nil {
		return err
	}
	var role string
	var disabled bool
	err = tx.QueryRow(ctx, "SELECT role,disabled_at IS NOT NULL FROM users WHERE id=$1 FOR UPDATE", userID).Scan(&role, &disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUserNotFound
	}
	if err != nil {
		return err
	}
	if role == "admin" && !disabled {
		var activeAdmins int64
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM users WHERE role='admin' AND disabled_at IS NULL").Scan(&activeAdmins); err != nil {
			return err
		}
		if activeAdmins <= 1 {
			return ErrLastActiveAdmin
		}
	}
	if _, err := tx.Exec(ctx, "DELETE FROM users WHERE id=$1", userID); err != nil {
		return fmt.Errorf("delete user: %w", err)
	}
	return tx.Commit(ctx)
}

func (s *Store) GetUserAccessInfo(ctx context.Context, userID int64, currentRawToken string) (UserAccessInfo, error) {
	var exists bool
	if err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)", userID).Scan(&exists); err != nil {
		return UserAccessInfo{}, err
	}
	if !exists {
		return UserAccessInfo{}, ErrUserNotFound
	}
	currentHash := sha256.Sum256([]byte(currentRawToken))
	rows, err := s.pool.Query(ctx, `
		SELECT created_at,last_seen_at,expires_at,created_ip,user_agent,token_hash=$2
		FROM user_sessions
		WHERE user_id=$1 AND expires_at > now()
		ORDER BY last_seen_at DESC`, userID, currentHash[:])
	if err != nil {
		return UserAccessInfo{}, fmt.Errorf("list user sessions: %w", err)
	}
	info := UserAccessInfo{Sessions: make([]UserSessionInfo, 0), RecentLogins: make([]UserLoginEvent, 0)}
	for rows.Next() {
		var item UserSessionInfo
		if err := rows.Scan(&item.CreatedAt, &item.LastSeenAt, &item.ExpiresAt, &item.ClientIP, &item.UserAgent, &item.Current); err != nil {
			rows.Close()
			return UserAccessInfo{}, err
		}
		info.Sessions = append(info.Sessions, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return UserAccessInfo{}, err
	}
	rows.Close()

	loginRows, err := s.pool.Query(ctx, `
		SELECT created_at,client_ip,status_code
		FROM audit_events
		WHERE actor_id=$1 AND action='auth.login.succeeded'
		ORDER BY created_at DESC,id DESC LIMIT 20`, userID)
	if err != nil {
		return UserAccessInfo{}, fmt.Errorf("list user logins: %w", err)
	}
	defer loginRows.Close()
	for loginRows.Next() {
		var item UserLoginEvent
		if err := loginRows.Scan(&item.CreatedAt, &item.ClientIP, &item.StatusCode); err != nil {
			return UserAccessInfo{}, err
		}
		info.RecentLogins = append(info.RecentLogins, item)
	}
	return info, loginRows.Err()
}
