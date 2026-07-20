package watchlibrary

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"peufmreader/internal/store"
)

type watcherRepository struct {
	existsChecks int
	exists       map[string]bool
	queued       []Payload
}

func (r *watcherRepository) BackgroundJobExists(_ context.Context, _, dedupeKey string) (bool, error) {
	r.existsChecks++
	return r.exists[dedupeKey], nil
}

func (r *watcherRepository) EnqueueBackgroundJob(_ context.Context, _, dedupeKey string, payload any, _ *int64, _ *int64, _ int) (store.BackgroundJob, bool, error) {
	r.exists[dedupeKey] = true
	r.queued = append(r.queued, payload.(Payload))
	return store.BackgroundJob{ID: int64(len(r.queued)), DedupeKey: dedupeKey}, true, nil
}

func TestWatcherQueuesStableFileOnceWithoutRepeatedDatabaseChecks(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "book.pdf"), []byte("%PDF-book"), 0o640); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(root)
	if err != nil {
		t.Fatal(err)
	}
	repository := &watcherRepository{exists: make(map[string]bool)}
	watcher := NewWatcher(manager, repository, 1, time.Minute, 30*time.Second, nil)
	started := time.Now()

	if queued, err := watcher.ScanOnce(context.Background(), started); err != nil || queued != 0 {
		t.Fatalf("first scan queued=%d err=%v", queued, err)
	}
	if queued, err := watcher.ScanOnce(context.Background(), started.Add(29*time.Second)); err != nil || queued != 0 {
		t.Fatalf("early scan queued=%d err=%v", queued, err)
	}
	if queued, err := watcher.ScanOnce(context.Background(), started.Add(30*time.Second)); err != nil || queued != 1 {
		t.Fatalf("stable scan queued=%d err=%v", queued, err)
	}
	if queued, err := watcher.ScanOnce(context.Background(), started.Add(2*time.Minute)); err != nil || queued != 0 {
		t.Fatalf("repeat scan queued=%d err=%v", queued, err)
	}
	if repository.existsChecks != 1 || len(repository.queued) != 1 {
		t.Fatalf("existsChecks=%d queued=%#v", repository.existsChecks, repository.queued)
	}
}
