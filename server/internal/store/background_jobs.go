package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type BackgroundJob struct {
	ID             int64           `json:"id"`
	Kind           string          `json:"kind"`
	State          string          `json:"state"`
	DedupeKey      string          `json:"dedupeKey"`
	Payload        json.RawMessage `json:"payload"`
	Result         json.RawMessage `json:"result"`
	Attempts       int             `json:"attempts"`
	MaxAttempts    int             `json:"maxAttempts"`
	AvailableAt    time.Time       `json:"availableAt"`
	LockedBy       string          `json:"-"`
	LeaseExpiresAt *time.Time      `json:"leaseExpiresAt,omitempty"`
	LastError      string          `json:"lastError,omitempty"`
	CreatedBy      *int64          `json:"createdBy,omitempty"`
	BookFileID     *int64          `json:"bookFileId,omitempty"`
	CreatedAt      time.Time       `json:"createdAt"`
	UpdatedAt      time.Time       `json:"updatedAt"`
	CompletedAt    *time.Time      `json:"completedAt,omitempty"`
}

const backgroundJobColumns = `
	id,kind,state,dedupe_key,payload,result,attempts,max_attempts,available_at,
	COALESCE(locked_by,''),lease_expires_at,COALESCE(last_error,''),created_by,book_file_id,
	created_at,updated_at,completed_at`

const claimedBackgroundJobColumns = `
	j.id,j.kind,j.state,j.dedupe_key,j.payload,j.result,j.attempts,j.max_attempts,j.available_at,
	COALESCE(j.locked_by,''),j.lease_expires_at,COALESCE(j.last_error,''),j.created_by,j.book_file_id,
	j.created_at,j.updated_at,j.completed_at`

func scanBackgroundJob(row scanner) (BackgroundJob, error) {
	var job BackgroundJob
	err := row.Scan(
		&job.ID, &job.Kind, &job.State, &job.DedupeKey, &job.Payload, &job.Result,
		&job.Attempts, &job.MaxAttempts, &job.AvailableAt, &job.LockedBy, &job.LeaseExpiresAt,
		&job.LastError, &job.CreatedBy, &job.BookFileID, &job.CreatedAt, &job.UpdatedAt, &job.CompletedAt,
	)
	return job, err
}

func (s *Store) EnqueueBackgroundJob(
	ctx context.Context,
	kind, dedupeKey string,
	payload any,
	createdBy *int64,
	bookFileID *int64,
	maxAttempts int,
) (BackgroundJob, bool, error) {
	kind = strings.TrimSpace(kind)
	dedupeKey = strings.TrimSpace(dedupeKey)
	if kind == "" || dedupeKey == "" {
		return BackgroundJob{}, false, errors.New("background job kind and dedupe key are required")
	}
	if maxAttempts < 1 || maxAttempts > 20 {
		maxAttempts = 3
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return BackgroundJob{}, false, fmt.Errorf("encode background job payload: %w", err)
	}
	job, err := scanBackgroundJob(s.pool.QueryRow(ctx, `
		INSERT INTO background_jobs(kind,dedupe_key,payload,created_by,book_file_id,max_attempts)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (kind,dedupe_key) WHERE state IN ('queued','running') DO NOTHING
		RETURNING `+backgroundJobColumns,
		kind, dedupeKey, encoded, createdBy, bookFileID, maxAttempts,
	))
	if err == nil {
		return job, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return BackgroundJob{}, false, fmt.Errorf("enqueue background job: %w", err)
	}
	job, err = scanBackgroundJob(s.pool.QueryRow(ctx, `
		SELECT `+backgroundJobColumns+` FROM background_jobs
		WHERE kind=$1 AND dedupe_key=$2 AND state IN ('queued','running')
		ORDER BY id DESC LIMIT 1`, kind, dedupeKey))
	if err != nil {
		return BackgroundJob{}, false, fmt.Errorf("load existing background job: %w", err)
	}
	return job, false, nil
}

func (s *Store) RequeueExpiredBackgroundJobs(ctx context.Context) (int64, error) {
	command, err := s.pool.Exec(ctx, `
		UPDATE background_jobs SET
			state='queued',locked_by=NULL,lease_expires_at=NULL,available_at=now(),
			last_error='任务租约过期，服务重启后自动恢复',updated_at=now()
		WHERE state='running' AND lease_expires_at < now()`)
	if err != nil {
		return 0, fmt.Errorf("recover expired background jobs: %w", err)
	}
	return command.RowsAffected(), nil
}

func (s *Store) ClaimBackgroundJob(ctx context.Context, workerID string, lease time.Duration) (BackgroundJob, bool, error) {
	if strings.TrimSpace(workerID) == "" {
		return BackgroundJob{}, false, errors.New("worker ID is required")
	}
	if lease <= 0 {
		lease = 15 * time.Minute
	}
	job, err := scanBackgroundJob(s.pool.QueryRow(ctx, `
		WITH candidate AS (
			SELECT id FROM background_jobs
			WHERE state='queued' AND available_at <= now()
			ORDER BY available_at,created_at,id
			FOR UPDATE SKIP LOCKED LIMIT 1
		)
		UPDATE background_jobs j SET
			state='running',attempts=j.attempts+1,locked_by=$1,
			lease_expires_at=now()+$2::interval,updated_at=now()
		FROM candidate WHERE j.id=candidate.id
		RETURNING `+claimedBackgroundJobColumns, workerID, lease.String()))
	if errors.Is(err, pgx.ErrNoRows) {
		return BackgroundJob{}, false, nil
	}
	if err != nil {
		return BackgroundJob{}, false, fmt.Errorf("claim background job: %w", err)
	}
	return job, true, nil
}

func (s *Store) HeartbeatBackgroundJob(ctx context.Context, jobID int64, workerID string, lease time.Duration) error {
	command, err := s.pool.Exec(ctx, `
		UPDATE background_jobs SET lease_expires_at=now()+$1::interval,updated_at=now()
		WHERE id=$2 AND state='running' AND locked_by=$3`, lease.String(), jobID, workerID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return errors.New("background job lease is no longer owned by this worker")
	}
	return nil
}

func (s *Store) CompleteBackgroundJob(ctx context.Context, jobID int64, workerID string, result json.RawMessage) error {
	if len(result) == 0 {
		result = json.RawMessage(`{}`)
	}
	command, err := s.pool.Exec(ctx, `
		UPDATE background_jobs SET
			state='completed',result=$1,last_error=NULL,locked_by=NULL,lease_expires_at=NULL,
			completed_at=now(),updated_at=now()
		WHERE id=$2 AND state='running' AND locked_by=$3`, result, jobID, workerID)
	if err != nil {
		return fmt.Errorf("complete background job: %w", err)
	}
	if command.RowsAffected() == 0 {
		return errors.New("background job lease is no longer owned by this worker")
	}
	return nil
}

func (s *Store) FailBackgroundJob(ctx context.Context, job BackgroundJob, workerID string, failure error, retryDelay time.Duration) error {
	message := failure.Error()
	if len(message) > 2000 {
		message = message[:2000]
	}
	if retryDelay < 0 {
		retryDelay = 0
	}
	command, err := s.pool.Exec(ctx, `
		UPDATE background_jobs SET
			state=CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
			available_at=CASE WHEN attempts < max_attempts THEN now()+$1::interval ELSE available_at END,
			last_error=$2,locked_by=NULL,lease_expires_at=NULL,updated_at=now()
		WHERE id=$3 AND state='running' AND locked_by=$4`, retryDelay.String(), message, job.ID, workerID)
	if err != nil {
		return fmt.Errorf("fail background job: %w", err)
	}
	if command.RowsAffected() == 0 {
		return errors.New("background job lease is no longer owned by this worker")
	}
	return nil
}

func (s *Store) RetryBackgroundJob(ctx context.Context, jobID int64) (BackgroundJob, error) {
	job, err := scanBackgroundJob(s.pool.QueryRow(ctx, `
		UPDATE background_jobs SET
			state='queued',attempts=0,available_at=now(),locked_by=NULL,lease_expires_at=NULL,
			last_error=NULL,completed_at=NULL,updated_at=now()
		WHERE id=$1 AND state='failed'
		RETURNING `+backgroundJobColumns, jobID))
	if errors.Is(err, pgx.ErrNoRows) {
		return BackgroundJob{}, errors.New("only failed background jobs can be retried")
	}
	return job, err
}

func (s *Store) ListBackgroundJobs(ctx context.Context, limit int) ([]BackgroundJob, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `SELECT `+backgroundJobColumns+` FROM background_jobs ORDER BY created_at DESC,id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := make([]BackgroundJob, 0)
	for rows.Next() {
		job, scanErr := scanBackgroundJob(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}
