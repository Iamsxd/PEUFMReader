package store

import (
	"context"
	"fmt"
)

type BackgroundJobKindMetric struct {
	Kind                   string  `json:"kind"`
	CompletedLast24Hours   int     `json:"completedLast24Hours"`
	FailedLast24Hours      int     `json:"failedLast24Hours"`
	AverageDurationSeconds float64 `json:"averageDurationSeconds"`
	P95DurationSeconds     float64 `json:"p95DurationSeconds"`
}

// OperationsSnapshot only contains aggregate operational data. It deliberately
// excludes usernames, titles, IP addresses and reading content.
type OperationsSnapshot struct {
	QueuedJobs            int   `json:"queuedJobs"`
	RunningJobs           int   `json:"runningJobs"`
	FailedJobs            int   `json:"failedJobs"`
	RetryingJobs          int   `json:"retryingJobs"`
	FailedJobsLast24Hours int   `json:"failedJobsLast24Hours"`
	CompletedLast24Hours  int   `json:"completedLast24Hours"`
	OldestQueuedSeconds   int64 `json:"oldestQueuedSeconds"`
	ActiveReadingSessions int   `json:"activeReadingSessions"`
	ActiveUsers24Hours    int   `json:"activeUsers24Hours"`
	DatabaseConnections   int   `json:"databaseConnections"`
}

func (s *Store) GetOperationsSnapshot(ctx context.Context) (OperationsSnapshot, error) {
	var snapshot OperationsSnapshot
	err := s.pool.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM background_jobs WHERE state='queued')::int,
			(SELECT COUNT(*) FROM background_jobs WHERE state='running')::int,
			(SELECT COUNT(*) FROM background_jobs WHERE state='failed')::int,
			(SELECT COUNT(*) FROM background_jobs WHERE state='queued' AND attempts > 0)::int,
			(SELECT COUNT(*) FROM background_jobs WHERE state='failed' AND updated_at >= now()-INTERVAL '24 hours')::int,
			(SELECT COUNT(*) FROM background_jobs WHERE state='completed' AND completed_at >= now()-INTERVAL '24 hours')::int,
			COALESCE((SELECT EXTRACT(EPOCH FROM now()-MIN(created_at))::bigint
				FROM background_jobs WHERE state='queued' AND available_at <= now()),0),
			(SELECT COUNT(*) FROM reading_sessions WHERE ended_at IS NULL AND last_heartbeat_at >= now()-INTERVAL '2 minutes')::int,
			(SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE last_seen_at >= now()-INTERVAL '24 hours' AND expires_at > now())::int,
			(SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database())::int`,
	).Scan(
		&snapshot.QueuedJobs, &snapshot.RunningJobs, &snapshot.FailedJobs, &snapshot.RetryingJobs,
		&snapshot.FailedJobsLast24Hours, &snapshot.CompletedLast24Hours, &snapshot.OldestQueuedSeconds,
		&snapshot.ActiveReadingSessions, &snapshot.ActiveUsers24Hours, &snapshot.DatabaseConnections,
	)
	if err != nil {
		return OperationsSnapshot{}, fmt.Errorf("load operations snapshot: %w", err)
	}
	return snapshot, nil
}

// GetBackgroundJobKindMetrics reports end-to-end durations from enqueue to a
// terminal state. That intentionally includes queueing and retries so the
// result reflects the delay an administrator actually experiences.
func (s *Store) GetBackgroundJobKindMetrics(ctx context.Context) ([]BackgroundJobKindMetric, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT kind,
			COUNT(*) FILTER (WHERE state='completed')::int,
			COUNT(*) FILTER (WHERE state='failed')::int,
			COALESCE(AVG(EXTRACT(EPOCH FROM COALESCE(completed_at,updated_at)-created_at)),0)::double precision,
			COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (
				ORDER BY EXTRACT(EPOCH FROM COALESCE(completed_at,updated_at)-created_at)
			),0)::double precision
		FROM background_jobs
		WHERE state IN ('completed','failed')
			AND COALESCE(completed_at,updated_at) >= now()-INTERVAL '24 hours'
		GROUP BY kind
		ORDER BY kind`)
	if err != nil {
		return nil, fmt.Errorf("load background job kind metrics: %w", err)
	}
	defer rows.Close()
	items := make([]BackgroundJobKindMetric, 0)
	for rows.Next() {
		var item BackgroundJobKindMetric
		if err := rows.Scan(&item.Kind, &item.CompletedLast24Hours, &item.FailedLast24Hours, &item.AverageDurationSeconds, &item.P95DurationSeconds); err != nil {
			return nil, fmt.Errorf("scan background job kind metrics: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate background job kind metrics: %w", err)
	}
	return items, nil
}
