package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"time"

	"peufmreader/internal/store"
)

type Repository interface {
	RequeueExpiredBackgroundJobs(context.Context) (int64, error)
	ClaimBackgroundJob(context.Context, string, time.Duration) (store.BackgroundJob, bool, error)
	HeartbeatBackgroundJob(context.Context, int64, string, time.Duration) error
	UpdateBackgroundJobProgress(context.Context, int64, string, int, string) error
	CompleteBackgroundJob(context.Context, int64, string, json.RawMessage) error
	FailBackgroundJob(context.Context, store.BackgroundJob, string, error, time.Duration) error
}

type Handler func(context.Context, store.BackgroundJob) (any, error)

type progressReporterKey struct{}

type progressReporter func(int, string) error

func ReportProgress(ctx context.Context, progress int, message string) error {
	reporter, _ := ctx.Value(progressReporterKey{}).(progressReporter)
	if reporter == nil {
		return nil
	}
	return reporter(progress, message)
}

type Worker struct {
	repository Repository
	handlers   map[string]Handler
	logger     *slog.Logger
	workerID   string
	pollEvery  time.Duration
	lease      time.Duration
}

func New(repository Repository, handlers map[string]Handler, logger *slog.Logger, workerID string) *Worker {
	if logger == nil {
		logger = slog.Default()
	}
	return &Worker{
		repository: repository,
		handlers:   handlers,
		logger:     logger,
		workerID:   workerID,
		pollEvery:  2 * time.Second,
		lease:      15 * time.Minute,
	}
}

func (w *Worker) Run(ctx context.Context) {
	recovered, err := w.repository.RequeueExpiredBackgroundJobs(ctx)
	if err != nil {
		w.logger.Error("background job recovery failed", "error", err)
	} else if recovered > 0 {
		w.logger.Info("background jobs recovered", "count", recovered)
	}

	for ctx.Err() == nil {
		processed, runErr := w.RunOnce(ctx)
		if runErr != nil {
			w.logger.Error("background worker iteration failed", "error", runErr)
		}
		if processed {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(w.pollEvery):
		}
	}
}

func (w *Worker) RunOnce(ctx context.Context) (bool, error) {
	job, found, err := w.repository.ClaimBackgroundJob(ctx, w.workerID, w.lease)
	if err != nil || !found {
		return false, err
	}
	handler, ok := w.handlers[job.Kind]
	if !ok {
		err = fmt.Errorf("no handler registered for background job kind %q", job.Kind)
		return true, w.repository.FailBackgroundJob(ctx, job, w.workerID, err, retryDelay(job.Attempts))
	}

	jobCtx, cancel := context.WithCancel(ctx)
	jobCtx = context.WithValue(jobCtx, progressReporterKey{}, progressReporter(func(progress int, message string) error {
		return w.repository.UpdateBackgroundJobProgress(jobCtx, job.ID, w.workerID, progress, message)
	}))
	done := make(chan struct{})
	go w.keepLease(jobCtx, job.ID, done)
	result, handlerErr := handler(jobCtx, job)
	close(done)
	cancel()
	finalizeCtx, finalizeCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer finalizeCancel()

	if handlerErr != nil {
		w.logger.Warn("background job failed", "job_id", job.ID, "kind", job.Kind, "attempt", job.Attempts, "error", handlerErr)
		return true, w.repository.FailBackgroundJob(finalizeCtx, job, w.workerID, handlerErr, retryDelay(job.Attempts))
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return true, w.repository.FailBackgroundJob(finalizeCtx, job, w.workerID, fmt.Errorf("encode job result: %w", err), retryDelay(job.Attempts))
	}
	if err := w.repository.CompleteBackgroundJob(finalizeCtx, job.ID, w.workerID, encoded); err != nil {
		return true, err
	}
	w.logger.Info("background job completed", "job_id", job.ID, "kind", job.Kind, "attempt", job.Attempts)
	return true, nil
}

func (w *Worker) keepLease(ctx context.Context, jobID int64, done <-chan struct{}) {
	interval := w.lease / 3
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			if err := w.repository.HeartbeatBackgroundJob(ctx, jobID, w.workerID, w.lease); err != nil {
				w.logger.Error("background job heartbeat failed", "job_id", jobID, "error", err)
			}
		}
	}
}

func retryDelay(attempt int) time.Duration {
	exponent := math.Max(0, math.Min(float64(attempt-1), 8))
	delay := time.Duration(math.Pow(2, exponent)) * time.Second
	return min(delay, 5*time.Minute)
}
