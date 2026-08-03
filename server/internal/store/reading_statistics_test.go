package store

import (
	"testing"
	"time"
)

func TestCompleteDailyActivityFillsMissingDaysAndCalculatesStreaks(t *testing.T) {
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	activity := completeDailyActivity(now, 5, map[string]int64{
		"2026-07-30": 60, "2026-08-01": 120, "2026-08-02": 30, "2026-08-03": 90,
	})
	if len(activity) != 5 || activity[1].ActiveSeconds != 0 || activity[4].Date != "2026-08-03" {
		t.Fatalf("unexpected activity: %#v", activity)
	}
	current, longest := readingStreaks(activity)
	if current != 3 || longest != 3 {
		t.Fatalf("streaks current=%d longest=%d, want 3/3", current, longest)
	}
}
