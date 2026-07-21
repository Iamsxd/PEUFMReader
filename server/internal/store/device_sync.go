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
)

type DeviceToken struct {
	ID         int64      `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
}

type DeviceAuth struct {
	TokenID int64
	User    User
}

type DeviceProgress struct {
	Provider    string    `json:"provider"`
	DocumentKey string    `json:"document"`
	BookFileID  *int64    `json:"bookFileId,omitempty"`
	Locator     string    `json:"progress"`
	Percentage  float64   `json:"percentage"`
	Device      string    `json:"device,omitempty"`
	DeviceID    string    `json:"deviceId,omitempty"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

var ErrBookAccessDenied = errors.New("book access denied")

func (s *Store) CreateDeviceToken(ctx context.Context, userID int64, name, rawToken string, expiresAt *time.Time) (DeviceToken, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 100 || rawToken == "" {
		return DeviceToken{}, errors.New("invalid device token")
	}
	hash := sha256.Sum256([]byte(rawToken))
	var token DeviceToken
	err := s.pool.QueryRow(ctx, `INSERT INTO device_tokens(user_id,name,token_hash,expires_at) VALUES ($1,$2,$3,$4)
		RETURNING id,name,created_at,last_used_at,expires_at`, userID, name, hash[:], expiresAt).
		Scan(&token.ID, &token.Name, &token.CreatedAt, &token.LastUsedAt, &token.ExpiresAt)
	return token, err
}

func (s *Store) ListDeviceTokens(ctx context.Context, userID int64) ([]DeviceToken, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,name,created_at,last_used_at,expires_at FROM device_tokens
		WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]DeviceToken, 0)
	for rows.Next() {
		var item DeviceToken
		if err := rows.Scan(&item.ID, &item.Name, &item.CreatedAt, &item.LastUsedAt, &item.ExpiresAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) RevokeDeviceToken(ctx context.Context, userID, tokenID int64) (bool, error) {
	command, err := s.pool.Exec(ctx, "UPDATE device_tokens SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL", tokenID, userID)
	return command.RowsAffected() > 0, err
}

func (s *Store) AuthenticateDeviceToken(ctx context.Context, rawToken, username string) (DeviceAuth, bool, error) {
	hash := sha256.Sum256([]byte(rawToken))
	var auth DeviceAuth
	err := s.pool.QueryRow(ctx, `SELECT t.id,u.id,u.username,u.role FROM device_tokens t JOIN users u ON u.id=t.user_id
		WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now())
			AND u.disabled_at IS NULL AND ($2='' OR u.username=lower($2))`, hash[:], strings.TrimSpace(username)).
		Scan(&auth.TokenID, &auth.User.ID, &auth.User.Username, &auth.User.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return DeviceAuth{}, false, nil
	}
	if err != nil {
		return DeviceAuth{}, false, err
	}
	_, _ = s.pool.Exec(ctx, "UPDATE device_tokens SET last_used_at=now() WHERE id=$1", auth.TokenID)
	return auth, true, nil
}

func (s *Store) ResolveExternalDocument(ctx context.Context, document string) (*int64, error) {
	document = strings.TrimSpace(document)
	if strings.HasPrefix(document, "peufm:") {
		var id int64
		if _, err := fmt.Sscanf(document, "peufm:%d", &id); err == nil && id > 0 {
			var exists bool
			if err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM book_files WHERE id=$1)", id).Scan(&exists); err != nil {
				return nil, err
			}
			if exists {
				return &id, nil
			}
		}
	}
	var id int64
	err := s.pool.QueryRow(ctx, `SELECT id FROM book_files WHERE encode(sha256,'hex')=lower($1) OR lower(original_filename)=lower($1) ORDER BY id LIMIT 1`, document).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func (s *Store) SaveDeviceProgress(ctx context.Context, userID int64, progress DeviceProgress) (DeviceProgress, error) {
	progress.Provider = strings.ToLower(strings.TrimSpace(progress.Provider))
	progress.DocumentKey = strings.TrimSpace(progress.DocumentKey)
	progress.Locator = strings.TrimSpace(progress.Locator)
	progress.Device = strings.TrimSpace(progress.Device)
	progress.DeviceID = strings.TrimSpace(progress.DeviceID)
	if (progress.Provider != "koreader" && progress.Provider != "kobo" && progress.Provider != "generic") || progress.DocumentKey == "" || len(progress.DocumentKey) > 512 || progress.Percentage < 0 || progress.Percentage > 1 {
		return DeviceProgress{}, errors.New("invalid device progress")
	}
	if progress.BookFileID == nil {
		resolved, err := s.ResolveExternalDocument(ctx, progress.DocumentKey)
		if err != nil {
			return DeviceProgress{}, err
		}
		progress.BookFileID = resolved
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DeviceProgress{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if progress.BookFileID != nil {
		allowed, found, accessErr := s.CanAccessBook(ctx, userID, *progress.BookFileID)
		if accessErr != nil {
			return DeviceProgress{}, accessErr
		}
		if !found || !allowed {
			return DeviceProgress{}, ErrBookAccessDenied
		}
	}
	err = tx.QueryRow(ctx, `INSERT INTO external_reading_progress(user_id,provider,document_key,book_file_id,locator,percentage,device,device_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (user_id,provider,document_key) DO UPDATE SET book_file_id=COALESCE(EXCLUDED.book_file_id,external_reading_progress.book_file_id),
			locator=EXCLUDED.locator,percentage=EXCLUDED.percentage,device=EXCLUDED.device,device_id=EXCLUDED.device_id,updated_at=now()
		RETURNING provider,document_key,book_file_id,locator,percentage,device,device_id,updated_at`,
		userID, progress.Provider, progress.DocumentKey, progress.BookFileID, progress.Locator, progress.Percentage, progress.Device, progress.DeviceID).
		Scan(&progress.Provider, &progress.DocumentKey, &progress.BookFileID, &progress.Locator, &progress.Percentage, &progress.Device, &progress.DeviceID, &progress.UpdatedAt)
	if err != nil {
		return DeviceProgress{}, err
	}
	if progress.BookFileID != nil {
		position, _ := json.Marshal(map[string]any{"provider": progress.Provider, "document": progress.DocumentKey, "locator": progress.Locator})
		status := "reading"
		if progress.Percentage >= 0.999 {
			status = "finished"
		}
		if _, err := tx.Exec(ctx, `INSERT INTO reading_states(user_id,book_file_id,position,overall_progress,status,updated_at)
			VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (user_id,book_file_id) DO UPDATE SET
			position=EXCLUDED.position,overall_progress=EXCLUDED.overall_progress,status=EXCLUDED.status,updated_at=now()`,
			userID, *progress.BookFileID, position, progress.Percentage, status); err != nil {
			return DeviceProgress{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return DeviceProgress{}, err
	}
	return progress, nil
}

func (s *Store) GetDeviceProgress(ctx context.Context, userID int64, provider, document string) (DeviceProgress, bool, error) {
	var progress DeviceProgress
	err := s.pool.QueryRow(ctx, `SELECT provider,document_key,book_file_id,locator,percentage,device,device_id,updated_at
		FROM external_reading_progress WHERE user_id=$1 AND provider=$2 AND document_key=$3`, userID, provider, document).
		Scan(&progress.Provider, &progress.DocumentKey, &progress.BookFileID, &progress.Locator, &progress.Percentage, &progress.Device, &progress.DeviceID, &progress.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return DeviceProgress{}, false, nil
	}
	if err != nil {
		return DeviceProgress{}, false, err
	}
	if progress.BookFileID != nil {
		allowed, _, accessErr := s.CanAccessBook(ctx, userID, *progress.BookFileID)
		if accessErr != nil {
			return DeviceProgress{}, false, accessErr
		}
		if !allowed {
			return DeviceProgress{}, false, nil
		}
		var webProgress float64
		var webUpdated time.Time
		if err := s.pool.QueryRow(ctx, `SELECT overall_progress,updated_at FROM reading_states WHERE user_id=$1 AND book_file_id=$2`, userID, *progress.BookFileID).Scan(&webProgress, &webUpdated); err == nil && webUpdated.After(progress.UpdatedAt) {
			progress.Percentage = webProgress
			progress.UpdatedAt = webUpdated
		}
	}
	return progress, true, nil
}
