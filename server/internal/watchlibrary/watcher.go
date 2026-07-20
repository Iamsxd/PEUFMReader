package watchlibrary

import (
	"context"
	"log/slog"
	"time"

	"peufmreader/internal/store"
)

const JobKind = "watched-library-import"

type Payload struct {
	SourcePath       string `json:"sourcePath"`
	OriginalFilename string `json:"originalFilename"`
}

type Repository interface {
	BackgroundJobExists(context.Context, string, string) (bool, error)
	EnqueueBackgroundJob(context.Context, string, string, any, *int64, *int64, int) (store.BackgroundJob, bool, error)
}

type observedFile struct {
	sizeBytes   int64
	modifiedAt  time.Time
	stableSince time.Time
	queued      bool
}

type Watcher struct {
	manager    *Manager
	repository Repository
	createdBy  int64
	scanEvery  time.Duration
	stableAge  time.Duration
	logger     *slog.Logger
	observed   map[string]observedFile
}

func NewWatcher(manager *Manager, repository Repository, createdBy int64, scanEvery, stableAge time.Duration, logger *slog.Logger) *Watcher {
	if scanEvery <= 0 {
		scanEvery = time.Minute
	}
	if stableAge <= 0 {
		stableAge = 30 * time.Second
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Watcher{
		manager: manager, repository: repository, createdBy: createdBy,
		scanEvery: scanEvery, stableAge: stableAge, logger: logger, observed: make(map[string]observedFile),
	}
}

func (w *Watcher) Run(ctx context.Context) {
	w.scan(ctx, time.Now())
	ticker := time.NewTicker(w.scanEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			w.scan(ctx, now)
		}
	}
}

func (w *Watcher) scan(ctx context.Context, now time.Time) {
	queued, err := w.ScanOnce(ctx, now)
	if err != nil {
		w.logger.Error("watched library scan failed", "error", err)
	} else if queued > 0 {
		w.logger.Info("watched library jobs queued", "count", queued)
	}
}

func (w *Watcher) ScanOnce(ctx context.Context, now time.Time) (int, error) {
	candidates, err := w.manager.Candidates()
	if err != nil {
		return 0, err
	}
	current := make(map[string]struct{}, len(candidates))
	queued := 0
	for _, candidate := range candidates {
		current[candidate.SourcePath] = struct{}{}
		observation, seen := w.observed[candidate.SourcePath]
		if !seen || observation.sizeBytes != candidate.SizeBytes || !observation.modifiedAt.Equal(candidate.ModifiedAt) {
			w.observed[candidate.SourcePath] = observedFile{
				sizeBytes: candidate.SizeBytes, modifiedAt: candidate.ModifiedAt, stableSince: now,
			}
			continue
		}
		if observation.queued || now.Sub(observation.stableSince) < w.stableAge {
			continue
		}
		exists, err := w.repository.BackgroundJobExists(ctx, JobKind, candidate.DedupeKey)
		if err != nil {
			return queued, err
		}
		if !exists {
			_, created, enqueueErr := w.repository.EnqueueBackgroundJob(ctx, JobKind, candidate.DedupeKey, Payload{
				SourcePath: candidate.SourcePath, OriginalFilename: candidate.OriginalFilename,
			}, &w.createdBy, nil, 3)
			if enqueueErr != nil {
				return queued, enqueueErr
			}
			if created {
				queued++
			}
		}
		observation.queued = true
		w.observed[candidate.SourcePath] = observation
	}
	for path := range w.observed {
		if _, ok := current[path]; !ok {
			delete(w.observed, path)
		}
	}
	return queued, nil
}
