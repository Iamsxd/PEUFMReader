package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"peufmreader/internal/auth"
	"peufmreader/internal/library"
)

type Store struct {
	pool *pgxpool.Pool
}

type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

type Session struct {
	User      User
	CSRFToken string
	ExpiresAt time.Time
}

type BookFile struct {
	ID               int64      `json:"id"`
	WorkID           int64      `json:"workId,omitempty"`
	EditionID        int64      `json:"editionId"`
	Title            string     `json:"title"`
	Authors          []string   `json:"authors"`
	PublishedYear    *int       `json:"publishedYear,omitempty"`
	Language         string     `json:"language,omitempty"`
	ISBN             string     `json:"isbn,omitempty"`
	Publisher        string     `json:"publisher,omitempty"`
	Categories       []Category `json:"categories"`
	ReviewRequired   bool       `json:"reviewRequired"`
	CoverPath        string     `json:"-"`
	CoverURL         string     `json:"coverUrl,omitempty"`
	SHA256           []byte     `json:"-"`
	TextPath         string     `json:"-"`
	TextURL          string     `json:"textUrl,omitempty"`
	TextAvailable    bool       `json:"textAvailable"`
	TextMethod       string     `json:"textExtractionMethod,omitempty"`
	PageCount        *int       `json:"pageCount,omitempty"`
	OriginalFilename string     `json:"originalFilename"`
	StoragePath      string     `json:"-"`
	Format           string     `json:"format"`
	MIMEType         string     `json:"mimeType"`
	SizeBytes        int64      `json:"sizeBytes"`
	CreatedAt        time.Time  `json:"createdAt"`
}

type ReadingState struct {
	BookFileID        int64           `json:"bookFileId"`
	Position          json.RawMessage `json:"position"`
	OverallProgress   float64         `json:"overallProgress"`
	Status            string          `json:"status"`
	TotalActiveSecond int64           `json:"totalActiveSeconds"`
	UpdatedAt         time.Time       `json:"updatedAt"`
}

type ReadingSession struct {
	ID            int64      `json:"id"`
	BookFileID    int64      `json:"bookFileId"`
	StartedAt     time.Time  `json:"startedAt"`
	LastHeartbeat time.Time  `json:"lastHeartbeatAt"`
	EndedAt       *time.Time `json:"endedAt,omitempty"`
	ActiveSeconds int64      `json:"activeSeconds"`
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

func (s *Store) EnsureAdmin(ctx context.Context, username, password string) error {
	username = strings.ToLower(strings.TrimSpace(username))
	var exists bool
	if err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE username=$1)", username).Scan(&exists); err != nil {
		return fmt.Errorf("check initial admin: %w", err)
	}
	if exists {
		return nil
	}
	passwordHash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, "INSERT INTO users(username, password_hash, role) VALUES ($1,$2,'admin')", username, passwordHash)
	if err != nil {
		return fmt.Errorf("create initial admin: %w", err)
	}
	return nil
}

func (s *Store) Authenticate(ctx context.Context, username, password string) (User, bool, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	var user User
	var passwordHash string
	err := s.pool.QueryRow(ctx, `
		SELECT id, username, role, password_hash
		FROM users
		WHERE username=$1 AND disabled_at IS NULL`, username,
	).Scan(&user.ID, &user.Username, &user.Role, &passwordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, false, nil
	}
	if err != nil {
		return User{}, false, fmt.Errorf("load user for authentication: %w", err)
	}
	return user, auth.VerifyPassword(passwordHash, password), nil
}

func (s *Store) CreateUser(ctx context.Context, username, password, role string) (User, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	if username == "" || (role != "admin" && role != "reader") {
		return User{}, fmt.Errorf("invalid username or role")
	}
	passwordHash, err := auth.HashPassword(password)
	if err != nil {
		return User{}, err
	}
	var user User
	err = s.pool.QueryRow(ctx, `
		INSERT INTO users(username,password_hash,role) VALUES ($1,$2,$3)
		RETURNING id,username,role`, username, passwordHash, role,
	).Scan(&user.ID, &user.Username, &user.Role)
	if err != nil {
		return User{}, fmt.Errorf("create user: %w", err)
	}
	return user, nil
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.pool.Query(ctx, "SELECT id,username,role FROM users WHERE disabled_at IS NULL ORDER BY username")
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()
	users := make([]User, 0)
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.Username, &user.Role); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (s *Store) CreateSession(ctx context.Context, rawToken, csrfToken string, userID int64, expiresAt time.Time) error {
	hash := sha256.Sum256([]byte(rawToken))
	_, err := s.pool.Exec(ctx, `
		INSERT INTO user_sessions(token_hash,user_id,csrf_token,expires_at)
		VALUES ($1,$2,$3,$4)`, hash[:], userID, csrfToken, expiresAt,
	)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	return nil
}

func (s *Store) GetSession(ctx context.Context, rawToken string) (Session, bool, error) {
	hash := sha256.Sum256([]byte(rawToken))
	var session Session
	err := s.pool.QueryRow(ctx, `
		SELECT u.id,u.username,u.role,s.csrf_token,s.expires_at
		FROM user_sessions s
		JOIN users u ON u.id=s.user_id
		WHERE s.token_hash=$1 AND s.expires_at > now() AND u.disabled_at IS NULL`, hash[:],
	).Scan(&session.User.ID, &session.User.Username, &session.User.Role, &session.CSRFToken, &session.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, false, nil
	}
	if err != nil {
		return Session{}, false, fmt.Errorf("get session: %w", err)
	}
	_, _ = s.pool.Exec(ctx, "UPDATE user_sessions SET last_seen_at=now() WHERE token_hash=$1", hash[:])
	return session, true, nil
}

func (s *Store) DeleteSession(ctx context.Context, rawToken string) error {
	hash := sha256.Sum256([]byte(rawToken))
	_, err := s.pool.Exec(ctx, "DELETE FROM user_sessions WHERE token_hash=$1", hash[:])
	return err
}

func (s *Store) RegisterBook(ctx context.Context, stored library.StoredFile) (BookFile, bool, error) {
	var existing BookFile
	err := s.pool.QueryRow(ctx, `
		SELECT bf.id,bf.edition_id,w.title,bf.original_filename,bf.storage_path,bf.format,bf.mime_type,bf.size_bytes,bf.created_at
		FROM book_files bf JOIN editions e ON e.id=bf.edition_id JOIN works w ON w.id=e.work_id
		WHERE bf.sha256=$1`, stored.SHA256,
	).Scan(&existing.ID, &existing.EditionID, &existing.Title, &existing.OriginalFilename, &existing.StoragePath, &existing.Format, &existing.MIMEType, &existing.SizeBytes, &existing.CreatedAt)
	if err == nil {
		return existing, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return BookFile{}, false, fmt.Errorf("check duplicate book: %w", err)
	}

	title := strings.TrimSuffix(stored.OriginalFilename, filepathExt(stored.OriginalFilename))
	title = strings.TrimSpace(title)
	if title == "" {
		title = "Untitled"
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BookFile{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var workID, editionID int64
	if err := tx.QueryRow(ctx, "INSERT INTO works(title,sort_title) VALUES ($1,$2) RETURNING id", title, strings.ToLower(title)).Scan(&workID); err != nil {
		return BookFile{}, false, fmt.Errorf("create work: %w", err)
	}
	if err := tx.QueryRow(ctx, "INSERT INTO editions(work_id) VALUES ($1) RETURNING id", workID).Scan(&editionID); err != nil {
		return BookFile{}, false, fmt.Errorf("create edition: %w", err)
	}
	var book BookFile
	err = tx.QueryRow(ctx, `
		INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING id,edition_id,$8,original_filename,storage_path,format,mime_type,size_bytes,created_at`,
		editionID, stored.OriginalFilename, stored.RelativePath, stored.SHA256, stored.Format, stored.MIMEType, stored.SizeBytes, title,
	).Scan(&book.ID, &book.EditionID, &book.Title, &book.OriginalFilename, &book.StoragePath, &book.Format, &book.MIMEType, &book.SizeBytes, &book.CreatedAt)
	if err != nil {
		return BookFile{}, false, fmt.Errorf("create book file: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return BookFile{}, false, err
	}
	return book, false, nil
}

func filepathExt(name string) string {
	index := strings.LastIndex(name, ".")
	if index < 0 {
		return ""
	}
	return name[index:]
}

func (s *Store) ListBookFiles(ctx context.Context) ([]BookFile, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT bf.id,bf.edition_id,w.title,bf.original_filename,bf.storage_path,bf.format,bf.mime_type,bf.size_bytes,bf.created_at
		FROM book_files bf JOIN editions e ON e.id=bf.edition_id JOIN works w ON w.id=e.work_id
		ORDER BY w.sort_title,bf.id`)
	if err != nil {
		return nil, fmt.Errorf("list book files: %w", err)
	}
	defer rows.Close()
	books := make([]BookFile, 0)
	for rows.Next() {
		var book BookFile
		if err := rows.Scan(&book.ID, &book.EditionID, &book.Title, &book.OriginalFilename, &book.StoragePath, &book.Format, &book.MIMEType, &book.SizeBytes, &book.CreatedAt); err != nil {
			return nil, err
		}
		books = append(books, book)
	}
	return books, rows.Err()
}

func (s *Store) GetBookFile(ctx context.Context, id int64) (BookFile, bool, error) {
	var book BookFile
	err := s.pool.QueryRow(ctx, `
		SELECT bf.id,bf.edition_id,w.title,bf.original_filename,bf.storage_path,bf.format,bf.mime_type,bf.size_bytes,bf.created_at
		FROM book_files bf JOIN editions e ON e.id=bf.edition_id JOIN works w ON w.id=e.work_id
		WHERE bf.id=$1`, id,
	).Scan(&book.ID, &book.EditionID, &book.Title, &book.OriginalFilename, &book.StoragePath, &book.Format, &book.MIMEType, &book.SizeBytes, &book.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return BookFile{}, false, nil
	}
	if err != nil {
		return BookFile{}, false, err
	}
	return book, true, nil
}

func (s *Store) GetReadingState(ctx context.Context, userID, bookFileID int64) (ReadingState, error) {
	var state ReadingState
	err := s.pool.QueryRow(ctx, `
		SELECT book_file_id,position,overall_progress,status,total_active_seconds,updated_at
		FROM reading_states WHERE user_id=$1 AND book_file_id=$2`, userID, bookFileID,
	).Scan(&state.BookFileID, &state.Position, &state.OverallProgress, &state.Status, &state.TotalActiveSecond, &state.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReadingState{BookFileID: bookFileID, Position: json.RawMessage(`{}`), Status: "unread"}, nil
	}
	return state, err
}

func (s *Store) SaveReadingState(ctx context.Context, userID, bookFileID int64, position json.RawMessage, progress float64, status string) (ReadingState, error) {
	var state ReadingState
	err := s.pool.QueryRow(ctx, `
		INSERT INTO reading_states(user_id,book_file_id,position,overall_progress,status,updated_at)
		VALUES ($1,$2,$3,$4,$5,now())
		ON CONFLICT (user_id,book_file_id) DO UPDATE SET
			position=EXCLUDED.position,overall_progress=EXCLUDED.overall_progress,status=EXCLUDED.status,updated_at=now()
		RETURNING book_file_id,position,overall_progress,status,total_active_seconds,updated_at`,
		userID, bookFileID, position, progress, status,
	).Scan(&state.BookFileID, &state.Position, &state.OverallProgress, &state.Status, &state.TotalActiveSecond, &state.UpdatedAt)
	return state, err
}

func (s *Store) StartReadingSession(ctx context.Context, userID, bookFileID int64) (ReadingSession, error) {
	var session ReadingSession
	err := s.pool.QueryRow(ctx, `
		INSERT INTO reading_sessions(user_id,book_file_id) VALUES ($1,$2)
		RETURNING id,book_file_id,started_at,last_heartbeat_at,ended_at,active_seconds`, userID, bookFileID,
	).Scan(&session.ID, &session.BookFileID, &session.StartedAt, &session.LastHeartbeat, &session.EndedAt, &session.ActiveSeconds)
	return session, err
}

func (s *Store) AdvanceReadingSession(ctx context.Context, userID, sessionID, requestedSeconds int64, finish bool) (ReadingSession, error) {
	if requestedSeconds < 0 {
		requestedSeconds = 0
	}
	if requestedSeconds > 60 {
		requestedSeconds = 60
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReadingSession{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var session ReadingSession
	err = tx.QueryRow(ctx, `
		SELECT id,book_file_id,started_at,last_heartbeat_at,ended_at,active_seconds
		FROM reading_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, sessionID, userID,
	).Scan(&session.ID, &session.BookFileID, &session.StartedAt, &session.LastHeartbeat, &session.EndedAt, &session.ActiveSeconds)
	if err != nil {
		return ReadingSession{}, err
	}
	if session.EndedAt != nil {
		return session, nil
	}

	now := time.Now().UTC()
	elapsed := int64(now.Sub(session.LastHeartbeat).Seconds())
	if elapsed < 0 {
		elapsed = 0
	}
	accepted := min(requestedSeconds, elapsed+2)
	var endedAt any
	if finish {
		endedAt = now
	}
	err = tx.QueryRow(ctx, `
		UPDATE reading_sessions SET
			last_heartbeat_at=$1,active_seconds=active_seconds+$2,ended_at=COALESCE($3,ended_at)
		WHERE id=$4
		RETURNING id,book_file_id,started_at,last_heartbeat_at,ended_at,active_seconds`,
		now, accepted, endedAt, sessionID,
	).Scan(&session.ID, &session.BookFileID, &session.StartedAt, &session.LastHeartbeat, &session.EndedAt, &session.ActiveSeconds)
	if err != nil {
		return ReadingSession{}, err
	}
	if accepted > 0 {
		_, err = tx.Exec(ctx, `
			INSERT INTO reading_states(user_id,book_file_id,total_active_seconds)
			VALUES ($1,$2,$3)
			ON CONFLICT (user_id,book_file_id) DO UPDATE SET
				total_active_seconds=reading_states.total_active_seconds+$3,updated_at=now()`, userID, session.BookFileID, accepted)
		if err != nil {
			return ReadingSession{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ReadingSession{}, err
	}
	return session, nil
}
