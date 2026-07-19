package importinbox

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"peufmreader/internal/store"
)

type watcherRepository struct {
	exists map[string]bool
	queued []Payload
}

func (r *watcherRepository) BackgroundJobExists(_ context.Context, _, dedupeKey string) (bool, error) {
	return r.exists[dedupeKey], nil
}

func (r *watcherRepository) EnqueueBackgroundJob(_ context.Context, _, dedupeKey string, payload any, _ *int64, _ *int64, _ int) (store.BackgroundJob, bool, error) {
	r.exists[dedupeKey] = true
	r.queued = append(r.queued, payload.(Payload))
	return store.BackgroundJob{ID: int64(len(r.queued)), DedupeKey: dedupeKey}, true, nil
}

func TestWatcherWaitsUntilFileIsStableAndQueuesItOnce(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "inbox", "book.epub"), []byte("ebook"), 0o640); err != nil {
		t.Fatal(err)
	}
	repository := &watcherRepository{exists: make(map[string]bool)}
	watcher := NewWatcher(manager, repository, 1, time.Second, 10*time.Second, nil)
	started := time.Now()

	if queued, err := watcher.ScanOnce(context.Background(), started); err != nil || queued != 0 {
		t.Fatalf("first scan queued=%d err=%v", queued, err)
	}
	if queued, err := watcher.ScanOnce(context.Background(), started.Add(9*time.Second)); err != nil || queued != 0 {
		t.Fatalf("early scan queued=%d err=%v", queued, err)
	}
	if queued, err := watcher.ScanOnce(context.Background(), started.Add(10*time.Second)); err != nil || queued != 1 {
		t.Fatalf("stable scan queued=%d err=%v", queued, err)
	}
	if queued, err := watcher.ScanOnce(context.Background(), started.Add(20*time.Second)); err != nil || queued != 0 {
		t.Fatalf("repeat scan queued=%d err=%v", queued, err)
	}
	if len(repository.queued) != 1 || repository.queued[0].SourcePath != "book.epub" {
		t.Fatalf("unexpected payloads: %#v", repository.queued)
	}
}
