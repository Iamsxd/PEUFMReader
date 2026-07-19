package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"peufmreader/internal/store"
)

type fakeRepository struct {
	job       store.BackgroundJob
	found     bool
	completed json.RawMessage
	failed    error
}

func (f *fakeRepository) RequeueExpiredBackgroundJobs(context.Context) (int64, error) { return 0, nil }
func (f *fakeRepository) ClaimBackgroundJob(context.Context, string, time.Duration) (store.BackgroundJob, bool, error) {
	if !f.found {
		return store.BackgroundJob{}, false, nil
	}
	f.found = false
	return f.job, true, nil
}
func (f *fakeRepository) HeartbeatBackgroundJob(context.Context, int64, string, time.Duration) error {
	return nil
}
func (f *fakeRepository) CompleteBackgroundJob(_ context.Context, _ int64, _ string, result json.RawMessage) error {
	f.completed = result
	return nil
}
func (f *fakeRepository) FailBackgroundJob(_ context.Context, _ store.BackgroundJob, _ string, failure error, _ time.Duration) error {
	f.failed = failure
	return nil
}

func TestWorkerCompletesClaimedJob(t *testing.T) {
	repository := &fakeRepository{found: true, job: store.BackgroundJob{ID: 7, Kind: "test", Attempts: 1}}
	worker := New(repository, map[string]Handler{
		"test": func(context.Context, store.BackgroundJob) (any, error) { return map[string]any{"ok": true}, nil },
	}, slog.New(slog.NewTextHandler(io.Discard, nil)), "worker-test")

	processed, err := worker.RunOnce(context.Background())
	if err != nil || !processed {
		t.Fatalf("RunOnce() processed=%v err=%v", processed, err)
	}
	if string(repository.completed) != `{"ok":true}` {
		t.Fatalf("unexpected result %s", repository.completed)
	}
}

func TestWorkerReschedulesHandlerFailure(t *testing.T) {
	repository := &fakeRepository{found: true, job: store.BackgroundJob{ID: 8, Kind: "test", Attempts: 2}}
	worker := New(repository, map[string]Handler{
		"test": func(context.Context, store.BackgroundJob) (any, error) { return nil, errors.New("temporary failure") },
	}, slog.New(slog.NewTextHandler(io.Discard, nil)), "worker-test")

	processed, err := worker.RunOnce(context.Background())
	if err != nil || !processed {
		t.Fatalf("RunOnce() processed=%v err=%v", processed, err)
	}
	if repository.failed == nil || repository.failed.Error() != "temporary failure" {
		t.Fatalf("unexpected failure %v", repository.failed)
	}
}

func TestRetryDelayIsBounded(t *testing.T) {
	if retryDelay(1) != time.Second || retryDelay(99) != 4*time.Minute+16*time.Second {
		t.Fatalf("unexpected retry delays: first=%s last=%s", retryDelay(1), retryDelay(99))
	}
}
