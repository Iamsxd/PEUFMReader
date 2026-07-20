package config

import (
	"testing"
	"time"
)

func TestEnvOrIfUnsetPreservesExplicitEmptyValue(t *testing.T) {
	t.Setenv("PEUFM_TEST_OPTION", "")
	if value := envOrIfUnset("PEUFM_TEST_OPTION", "default"); value != "" {
		t.Fatalf("envOrIfUnset()=%q, want explicit empty value", value)
	}
}

func TestLoadWatchLibrarySettings(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/peufmreader")
	t.Setenv("ADMIN_PASSWORD", "a-secure-test-password")
	t.Setenv("BIBLIOGRAPHY_PROVIDERS", "")
	t.Setenv("AI_PROVIDER", "")
	t.Setenv("TRUSTED_PROXY_CIDR", "")
	t.Setenv("WATCH_LIBRARY_ENABLED", "true")
	t.Setenv("WATCH_LIBRARY_ROOT", "/watch/library")
	t.Setenv("WATCH_LIBRARY_LABEL", "/mnt/user/ebooks")
	t.Setenv("WATCH_LIBRARY_SCAN_INTERVAL", "2m")
	t.Setenv("WATCH_LIBRARY_STABLE_AGE", "45s")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.WatchLibraryEnabled || cfg.WatchLibraryRoot != "/watch/library" || cfg.WatchLibraryLabel != "/mnt/user/ebooks" {
		t.Fatalf("unexpected watch library config: %#v", cfg)
	}
	if cfg.WatchLibraryScanEvery != 2*time.Minute || cfg.WatchLibraryStableAge != 45*time.Second {
		t.Fatalf("unexpected watch timing: scan=%v stable=%v", cfg.WatchLibraryScanEvery, cfg.WatchLibraryStableAge)
	}
}

func TestLoadRejectsInvalidWatchLibraryEnabled(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/peufmreader")
	t.Setenv("ADMIN_PASSWORD", "a-secure-test-password")
	t.Setenv("BIBLIOGRAPHY_PROVIDERS", "")
	t.Setenv("AI_PROVIDER", "")
	t.Setenv("TRUSTED_PROXY_CIDR", "")
	t.Setenv("WATCH_LIBRARY_ENABLED", "sometimes")

	if _, err := Load(); err == nil {
		t.Fatal("invalid WATCH_LIBRARY_ENABLED was accepted")
	}
}
