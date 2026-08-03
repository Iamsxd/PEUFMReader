package store

import (
	"context"
	"fmt"
)

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
