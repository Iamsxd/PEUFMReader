package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrReadingMarkConflict = errors.New("reading mark changed on another device")
var ErrReadingMarkOperationReuse = errors.New("operation ID reused with different input")
var ErrReadingMarkMissing = errors.New("reading mark not found")

type ReadingMarkMutation struct {
	AccountID         int64       `json:"accountId"`
	OperationID       string      `json:"operationId"`
	Action            string      `json:"action"`
	BookFileID        int64       `json:"bookFileId"`
	MarkID            int64       `json:"markId"`
	ExpectedUpdatedAt *time.Time  `json:"expectedUpdatedAt,omitempty"`
	Mark              ReadingMark `json:"mark"`
}

type ReadingMarkMutationResult struct {
	Mark    *ReadingMark `json:"mark,omitempty"`
	Deleted bool         `json:"deleted"`
}

// SyncReadingMark is atomic with its receipt. ExpectedUpdatedAt is mandatory
// for changes to existing marks; timestamps are compared inside the UPDATE.
func (s *Store) SyncReadingMark(ctx context.Context, userID int64, input ReadingMarkMutation) (ReadingMarkMutationResult, error) {
	encoded, err := json.Marshal(input)
	if err != nil {
		return ReadingMarkMutationResult{}, err
	}
	hash := sha256.Sum256(encoded)
	digest := hex.EncodeToString(hash[:])
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReadingMarkMutationResult{}, err
	}
	defer tx.Rollback(ctx)
	// Serialize each user's sync receipts, including concurrent retries.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1,$2)`, int32(731031), int32(userID)); err != nil {
		return ReadingMarkMutationResult{}, err
	}
	var storedHash string
	var receipt []byte
	err = tx.QueryRow(ctx, `SELECT request_hash,result FROM reading_mark_sync_receipts WHERE user_id=$1 AND operation_id=$2::uuid`, userID, input.OperationID).Scan(&storedHash, &receipt)
	if err == nil {
		if storedHash != digest {
			return ReadingMarkMutationResult{}, ErrReadingMarkOperationReuse
		}
		var result ReadingMarkMutationResult
		if err = json.Unmarshal(receipt, &result); err != nil {
			return result, err
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ReadingMarkMutationResult{}, err
	}
	var result ReadingMarkMutationResult
	if input.Action == "create" {
		m := input.Mark
		mark, createErr := scanReadingMark(tx.QueryRow(ctx, `INSERT INTO reading_marks(user_id,book_file_id,kind,position,overall_progress,label,body,quote,color)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			ON CONFLICT (user_id,book_file_id,kind,position) WHERE kind='bookmark' DO UPDATE SET id=reading_marks.id
			RETURNING `+readingMarkColumns, userID, input.BookFileID, m.Kind, m.Position, m.OverallProgress, m.Label, m.Body, m.Quote, m.Color))
		if createErr != nil {
			return result, createErr
		}
		result.Mark = &mark
	} else {
		var existing ReadingMark
		existing, err = scanReadingMark(tx.QueryRow(ctx, `SELECT `+readingMarkColumns+` FROM reading_marks WHERE id=$1 AND user_id=$2 AND book_file_id=$3 FOR UPDATE`, input.MarkID, userID, input.BookFileID))
		if errors.Is(err, pgx.ErrNoRows) {
			return result, ErrReadingMarkMissing
		}
		if err != nil {
			return result, err
		}
		if input.ExpectedUpdatedAt == nil || !existing.UpdatedAt.Equal(*input.ExpectedUpdatedAt) {
			return result, ErrReadingMarkConflict
		}
		if input.Action == "delete" {
			_, err = tx.Exec(ctx, `DELETE FROM reading_marks WHERE id=$1 AND user_id=$2`, input.MarkID, userID)
			result.Deleted = true
		} else {
			var mark ReadingMark
			mark, err = scanReadingMark(tx.QueryRow(ctx, `UPDATE reading_marks SET label=$1,body=$2,color=$3,updated_at=clock_timestamp() WHERE id=$4 AND user_id=$5 RETURNING `+readingMarkColumns, input.Mark.Label, input.Mark.Body, input.Mark.Color, input.MarkID, userID))
			result.Mark = &mark
		}
		if err != nil {
			return result, err
		}
	}
	receipt, err = json.Marshal(result)
	if err != nil {
		return result, err
	}
	markID := input.MarkID
	if result.Mark != nil {
		markID = result.Mark.ID
	}
	_, err = tx.Exec(ctx, `INSERT INTO reading_mark_sync_receipts(user_id,operation_id,book_file_id,mark_id,request_hash,result) VALUES ($1,$2::uuid,$3,$4,$5,$6)`, userID, input.OperationID, input.BookFileID, markID, digest, receipt)
	if err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
