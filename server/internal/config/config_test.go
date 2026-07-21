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
	t.Setenv("PDF_OCR_MAX_PAGES", "")

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
	if cfg.PDFOCRMaxPages != 8 {
		t.Fatalf("PDFOCRMaxPages=%d, want front-matter default 8", cfg.PDFOCRMaxPages)
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

func TestLoadRequiresCompletePublicSecurityConfiguration(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/peufmreader")
	t.Setenv("ADMIN_PASSWORD", "a-secure-test-password")
	t.Setenv("BIBLIOGRAPHY_PROVIDERS", "")
	t.Setenv("AI_PROVIDER", "")
	t.Setenv("PUBLIC_ACCESS", "true")
	t.Setenv("PUBLIC_URL", "https://reader.example.com")
	t.Setenv("COOKIE_SECURE", "true")
	t.Setenv("TRUSTED_PROXY_CIDR", "172.18.0.0/16")
	t.Setenv("ALLOWED_HOSTS", "reader.example.com")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.PublicAccess || len(cfg.AllowedHosts) != 1 || cfg.AllowedHosts[0] != "reader.example.com" {
		t.Fatalf("unexpected public security config: %#v", cfg)
	}
}

func TestLoadRejectsPublicHTTPURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/peufmreader")
	t.Setenv("ADMIN_PASSWORD", "a-secure-test-password")
	t.Setenv("BIBLIOGRAPHY_PROVIDERS", "")
	t.Setenv("AI_PROVIDER", "")
	t.Setenv("PUBLIC_ACCESS", "true")
	t.Setenv("PUBLIC_URL", "http://reader.example.com")
	t.Setenv("COOKIE_SECURE", "true")
	t.Setenv("TRUSTED_PROXY_CIDR", "172.18.0.0/16")
	t.Setenv("ALLOWED_HOSTS", "reader.example.com")

	if _, err := Load(); err == nil {
		t.Fatal("PUBLIC_ACCESS accepted an HTTP public URL")
	}
}

func TestLoadRejectsIncompleteOIDCConfiguration(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/peufmreader")
	t.Setenv("ADMIN_PASSWORD", "a-secure-test-password")
	t.Setenv("BIBLIOGRAPHY_PROVIDERS", "")
	t.Setenv("AI_PROVIDER", "")
	t.Setenv("OIDC_ISSUER_URL", "https://id.example.com")

	if _, err := Load(); err == nil {
		t.Fatal("incomplete OIDC configuration was accepted")
	}
}
