package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

type ReadingMark struct {
	ID              int64           `json:"id"`
	BookFileID      int64           `json:"bookFileId"`
	Kind            string          `json:"kind"`
	Position        json.RawMessage `json:"position"`
	OverallProgress float64         `json:"overallProgress"`
	Label           string          `json:"label"`
	Body            string          `json:"body"`
	Quote           string          `json:"quote"`
	Color           string          `json:"color"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
}

const readingMarkColumns = `id,book_file_id,kind,position,overall_progress,label,body,quote,color,created_at,updated_at`

type readingMarkScanner interface {
	Scan(dest ...any) error
}

func scanReadingMark(row readingMarkScanner) (ReadingMark, error) {
	var mark ReadingMark
	err := row.Scan(&mark.ID, &mark.BookFileID, &mark.Kind, &mark.Position, &mark.OverallProgress, &mark.Label, &mark.Body, &mark.Quote, &mark.Color, &mark.CreatedAt, &mark.UpdatedAt)
	return mark, err
}

func (s *Store) ListReadingMarks(ctx context.Context, userID, bookFileID int64) ([]ReadingMark, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+readingMarkColumns+` FROM reading_marks
		WHERE user_id=$1 AND book_file_id=$2 ORDER BY overall_progress,id`, userID, bookFileID)
	if err != nil {
		return nil, fmt.Errorf("list reading marks: %w", err)
	}
	defer rows.Close()
	marks := make([]ReadingMark, 0)
	for rows.Next() {
		mark, scanErr := scanReadingMark(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		marks = append(marks, mark)
	}
	return marks, rows.Err()
}

func (s *Store) SaveReadingMark(ctx context.Context, userID, bookFileID int64, kind string, position json.RawMessage, progress float64, label, body, quote, color string) (ReadingMark, error) {
	mark, err := scanReadingMark(s.pool.QueryRow(ctx, `
		INSERT INTO reading_marks(user_id,book_file_id,kind,position,overall_progress,label,body,quote,color)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (user_id,book_file_id,kind,position) WHERE kind='bookmark' DO UPDATE SET
			overall_progress=EXCLUDED.overall_progress,label=EXCLUDED.label,body=EXCLUDED.body,updated_at=now()
		RETURNING `+readingMarkColumns, userID, bookFileID, kind, position, progress, label, body, quote, color))
	if err != nil {
		return ReadingMark{}, fmt.Errorf("save reading mark: %w", err)
	}
	return mark, nil
}

func (s *Store) GetReadingMark(ctx context.Context, userID, markID int64) (ReadingMark, bool, error) {
	mark, err := scanReadingMark(s.pool.QueryRow(ctx, `SELECT `+readingMarkColumns+` FROM reading_marks WHERE id=$1 AND user_id=$2`, markID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ReadingMark{}, false, nil
	}
	if err != nil {
		return ReadingMark{}, false, fmt.Errorf("get reading mark: %w", err)
	}
	return mark, true, nil
}

func (s *Store) UpdateReadingMark(ctx context.Context, userID, markID int64, label, body, color string) (ReadingMark, bool, error) {
	mark, err := scanReadingMark(s.pool.QueryRow(ctx, `UPDATE reading_marks SET label=$1,body=$2,color=$3,updated_at=now()
		WHERE id=$4 AND user_id=$5 RETURNING `+readingMarkColumns, label, body, color, markID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ReadingMark{}, false, nil
	}
	if err != nil {
		return ReadingMark{}, false, fmt.Errorf("update reading mark: %w", err)
	}
	return mark, true, nil
}

func (s *Store) DeleteReadingMark(ctx context.Context, userID, markID int64) (bool, error) {
	command, err := s.pool.Exec(ctx, "DELETE FROM reading_marks WHERE id=$1 AND user_id=$2", markID, userID)
	if err != nil {
		return false, fmt.Errorf("delete reading mark: %w", err)
	}
	return command.RowsAffected() > 0, nil
}
