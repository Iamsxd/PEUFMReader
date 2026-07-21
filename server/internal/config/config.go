package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Address               string
	DatabaseURL           string
	LibraryRoot           string
	StagingRoot           string
	CacheRoot             string
	CalibreRoot           string
	ImportRoot            string
	ImportRootLabel       string
	ImportScanInterval    time.Duration
	ImportStableAge       time.Duration
	WatchLibraryEnabled   bool
	WatchLibraryRoot      string
	WatchLibraryLabel     string
	WatchLibraryScanEvery time.Duration
	WatchLibraryStableAge time.Duration
	WebRoot               string
	AdminUsername         string
	AdminPassword         string
	CookieSecure          bool
	SessionTTL            time.Duration
	MaxUploadBytes        int64
	TrustedProxyCIDR      string
	PublicURL             string
	PublicAccess          bool
	AllowedHosts          []string
	OIDCIssuerURL         string
	OIDCClientID          string
	OIDCClientSecret      string
	OIDCRedirectURL       string
	OIDCUsernameClaim     string
	OIDCGroupsClaim       string
	OIDCAdminGroup        string
	LDAPURL               string
	LDAPStartTLS          bool
	LDAPBaseDN            string
	LDAPBindDN            string
	LDAPBindPassword      string
	LDAPUserFilter        string
	LDAPUsernameAttribute string
	LDAPAdminGroupDN      string
	AIProvider            string
	AIBaseURL             string
	AIModel               string
	AIAPIKey              string
	AITimeout             time.Duration
	BibliographyProviders string
	OpenLibraryBaseURL    string
	GoogleBooksBaseURL    string
	GoogleBooksAPIKey     string
	DoubanBaseURL         string
	BibliographyTimeout   time.Duration
	PDFOCRMode            string
	PDFOCRLanguages       string
	PDFOCRMaxPages        int
	PDFOCRDPI             int
	MOBIConverterBinary   string
	MOBIConversionTimeout time.Duration
}

func Load() (Config, error) {
	cfg := Config{
		Address:               envOr("ADDRESS", ":8080"),
		DatabaseURL:           os.Getenv("DATABASE_URL"),
		LibraryRoot:           envOr("LIBRARY_ROOT", "/data/library"),
		StagingRoot:           envOr("STAGING_ROOT", "/data/staging"),
		CacheRoot:             envOr("CACHE_ROOT", "/data/cache"),
		CalibreRoot:           envOr("CALIBRE_LIBRARY_ROOT", "/import/calibre"),
		ImportRoot:            envOr("IMPORT_ROOT", "/data/import"),
		ImportRootLabel:       strings.TrimSpace(envOr("IMPORT_ROOT_LABEL", envOr("IMPORT_ROOT", "/data/import"))),
		ImportScanInterval:    10 * time.Second,
		ImportStableAge:       10 * time.Second,
		WatchLibraryRoot:      envOr("WATCH_LIBRARY_ROOT", "/watch/library"),
		WatchLibraryLabel:     strings.TrimSpace(envOr("WATCH_LIBRARY_LABEL", envOr("WATCH_LIBRARY_ROOT", "/watch/library"))),
		WatchLibraryScanEvery: time.Minute,
		WatchLibraryStableAge: 30 * time.Second,
		WebRoot:               envOr("WEB_ROOT", "/app/web"),
		AdminUsername:         strings.ToLower(strings.TrimSpace(envOr("ADMIN_USERNAME", "admin"))),
		AdminPassword:         os.Getenv("ADMIN_PASSWORD"),
		SessionTTL:            30 * 24 * time.Hour,
		MaxUploadBytes:        500 << 20,
		TrustedProxyCIDR:      strings.TrimSpace(os.Getenv("TRUSTED_PROXY_CIDR")),
		PublicURL:             strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_URL")), "/"),
		AllowedHosts:          splitCSV(os.Getenv("ALLOWED_HOSTS")),
		OIDCIssuerURL:         strings.TrimRight(strings.TrimSpace(os.Getenv("OIDC_ISSUER_URL")), "/"),
		OIDCClientID:          strings.TrimSpace(os.Getenv("OIDC_CLIENT_ID")),
		OIDCClientSecret:      os.Getenv("OIDC_CLIENT_SECRET"),
		OIDCRedirectURL:       strings.TrimSpace(os.Getenv("OIDC_REDIRECT_URL")),
		OIDCUsernameClaim:     strings.TrimSpace(envOr("OIDC_USERNAME_CLAIM", "preferred_username")),
		OIDCGroupsClaim:       strings.TrimSpace(envOr("OIDC_GROUPS_CLAIM", "groups")),
		OIDCAdminGroup:        strings.TrimSpace(os.Getenv("OIDC_ADMIN_GROUP")),
		LDAPURL:               strings.TrimSpace(os.Getenv("LDAP_URL")),
		LDAPBaseDN:            strings.TrimSpace(os.Getenv("LDAP_BASE_DN")),
		LDAPBindDN:            strings.TrimSpace(os.Getenv("LDAP_BIND_DN")),
		LDAPBindPassword:      os.Getenv("LDAP_BIND_PASSWORD"),
		LDAPUserFilter:        strings.TrimSpace(envOr("LDAP_USER_FILTER", "(uid={username})")),
		LDAPUsernameAttribute: strings.TrimSpace(envOr("LDAP_USERNAME_ATTRIBUTE", "uid")),
		LDAPAdminGroupDN:      strings.TrimSpace(os.Getenv("LDAP_ADMIN_GROUP_DN")),
		AIProvider:            strings.ToLower(strings.TrimSpace(os.Getenv("AI_PROVIDER"))),
		AIBaseURL:             strings.TrimRight(strings.TrimSpace(os.Getenv("AI_BASE_URL")), "/"),
		AIModel:               strings.TrimSpace(os.Getenv("AI_MODEL")),
		AIAPIKey:              os.Getenv("AI_API_KEY"),
		AITimeout:             45 * time.Second,
		BibliographyProviders: strings.ToLower(strings.TrimSpace(envOrIfUnset("BIBLIOGRAPHY_PROVIDERS", "openlibrary"))),
		OpenLibraryBaseURL:    strings.TrimRight(envOr("OPEN_LIBRARY_BASE_URL", "https://openlibrary.org"), "/"),
		GoogleBooksBaseURL:    strings.TrimRight(envOr("GOOGLE_BOOKS_BASE_URL", "https://www.googleapis.com/books/v1"), "/"),
		GoogleBooksAPIKey:     os.Getenv("GOOGLE_BOOKS_API_KEY"),
		DoubanBaseURL:         strings.TrimRight(strings.TrimSpace(os.Getenv("DOUBAN_API_BASE_URL")), "/"),
		BibliographyTimeout:   12 * time.Second,
		PDFOCRMode:            strings.ToLower(strings.TrimSpace(envOr("PDF_OCR_MODE", "auto"))),
		PDFOCRLanguages:       strings.TrimSpace(envOr("PDF_OCR_LANGUAGES", "chi_sim+eng")),
		PDFOCRMaxPages:        8,
		PDFOCRDPI:             180,
		MOBIConverterBinary:   strings.TrimSpace(envOr("MOBI_CONVERTER_BIN", "mobitool")),
		MOBIConversionTimeout: 2 * time.Minute,
	}

	if cfg.DatabaseURL == "" {
		dbPassword := os.Getenv("DB_PASSWORD")
		if dbPassword == "" {
			return Config{}, fmt.Errorf("DATABASE_URL or DB_PASSWORD is required")
		}
		databaseURL := &url.URL{
			Scheme: "postgres",
			User:   url.UserPassword(envOr("DB_USER", "peufmreader"), dbPassword),
			Host:   envOr("DB_HOST", "db") + ":" + envOr("DB_PORT", "5432"),
			Path:   envOr("DB_NAME", "peufmreader"),
		}
		query := databaseURL.Query()
		query.Set("sslmode", envOr("DB_SSLMODE", "disable"))
		databaseURL.RawQuery = query.Encode()
		cfg.DatabaseURL = databaseURL.String()
	}
	if cfg.AdminPassword == "" {
		return Config{}, fmt.Errorf("ADMIN_PASSWORD is required")
	}
	if cfg.TrustedProxyCIDR != "" {
		if _, _, err := net.ParseCIDR(cfg.TrustedProxyCIDR); err != nil {
			return Config{}, fmt.Errorf("TRUSTED_PROXY_CIDR must be a valid CIDR")
		}
	}
	if len(cfg.AdminPassword) < 12 {
		return Config{}, fmt.Errorf("ADMIN_PASSWORD must contain at least 12 characters")
	}

	var err error
	if raw := os.Getenv("COOKIE_SECURE"); raw != "" {
		cfg.CookieSecure, err = strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("parse COOKIE_SECURE: %w", err)
		}
	}
	if raw := os.Getenv("PUBLIC_ACCESS"); raw != "" {
		cfg.PublicAccess, err = strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("parse PUBLIC_ACCESS: %w", err)
		}
	}
	if raw := os.Getenv("LDAP_START_TLS"); raw != "" {
		cfg.LDAPStartTLS, err = strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("parse LDAP_START_TLS: %w", err)
		}
	}
	if raw := os.Getenv("SESSION_TTL"); raw != "" {
		cfg.SessionTTL, err = time.ParseDuration(raw)
		if err != nil {
			return Config{}, fmt.Errorf("parse SESSION_TTL: %w", err)
		}
	}
	if raw := os.Getenv("MAX_UPLOAD_BYTES"); raw != "" {
		cfg.MaxUploadBytes, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || cfg.MaxUploadBytes <= 0 {
			return Config{}, fmt.Errorf("MAX_UPLOAD_BYTES must be a positive integer")
		}
	}
	if raw := os.Getenv("IMPORT_SCAN_INTERVAL"); raw != "" {
		cfg.ImportScanInterval, err = time.ParseDuration(raw)
		if err != nil || cfg.ImportScanInterval < time.Second || cfg.ImportScanInterval > time.Hour {
			return Config{}, fmt.Errorf("IMPORT_SCAN_INTERVAL must be between 1s and 1h")
		}
	}
	if raw := os.Getenv("IMPORT_STABLE_AGE"); raw != "" {
		cfg.ImportStableAge, err = time.ParseDuration(raw)
		if err != nil || cfg.ImportStableAge < time.Second || cfg.ImportStableAge > time.Hour {
			return Config{}, fmt.Errorf("IMPORT_STABLE_AGE must be between 1s and 1h")
		}
	}
	if raw := os.Getenv("WATCH_LIBRARY_ENABLED"); raw != "" {
		cfg.WatchLibraryEnabled, err = strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("parse WATCH_LIBRARY_ENABLED: %w", err)
		}
	}
	if raw := os.Getenv("WATCH_LIBRARY_SCAN_INTERVAL"); raw != "" {
		cfg.WatchLibraryScanEvery, err = time.ParseDuration(raw)
		if err != nil || cfg.WatchLibraryScanEvery < 5*time.Second || cfg.WatchLibraryScanEvery > 24*time.Hour {
			return Config{}, fmt.Errorf("WATCH_LIBRARY_SCAN_INTERVAL must be between 5s and 24h")
		}
	}
	if raw := os.Getenv("WATCH_LIBRARY_STABLE_AGE"); raw != "" {
		cfg.WatchLibraryStableAge, err = time.ParseDuration(raw)
		if err != nil || cfg.WatchLibraryStableAge < time.Second || cfg.WatchLibraryStableAge > time.Hour {
			return Config{}, fmt.Errorf("WATCH_LIBRARY_STABLE_AGE must be between 1s and 1h")
		}
	}
	if cfg.AIProvider != "" {
		if cfg.AIProvider != "ollama" && cfg.AIProvider != "openai-compatible" {
			return Config{}, fmt.Errorf("AI_PROVIDER must be ollama or openai-compatible")
		}
		if cfg.AIModel == "" {
			return Config{}, fmt.Errorf("AI_MODEL is required when AI_PROVIDER is enabled")
		}
		if cfg.AIBaseURL == "" && cfg.AIProvider == "ollama" {
			cfg.AIBaseURL = "http://host.docker.internal:11434"
		}
		parsedAIURL, parseErr := url.Parse(cfg.AIBaseURL)
		if parseErr != nil || (parsedAIURL.Scheme != "http" && parsedAIURL.Scheme != "https") || parsedAIURL.Host == "" {
			return Config{}, fmt.Errorf("AI_BASE_URL must be an absolute HTTP(S) URL")
		}
	}
	if raw := os.Getenv("AI_TIMEOUT"); raw != "" {
		cfg.AITimeout, err = time.ParseDuration(raw)
		if err != nil || cfg.AITimeout <= 0 || cfg.AITimeout > 5*time.Minute {
			return Config{}, fmt.Errorf("AI_TIMEOUT must be between 1ns and 5m")
		}
	}
	for _, provider := range strings.Split(cfg.BibliographyProviders, ",") {
		provider = strings.TrimSpace(provider)
		if provider != "" && provider != "openlibrary" && provider != "google-books" && provider != "douban" {
			return Config{}, fmt.Errorf("BIBLIOGRAPHY_PROVIDERS supports openlibrary, google-books, and douban")
		}
		if provider == "google-books" && cfg.GoogleBooksAPIKey == "" {
			return Config{}, fmt.Errorf("GOOGLE_BOOKS_API_KEY is required when google-books is enabled")
		}
		if provider == "douban" && cfg.DoubanBaseURL == "" {
			return Config{}, fmt.Errorf("DOUBAN_API_BASE_URL is required when douban is enabled")
		}
	}
	if raw := os.Getenv("BIBLIOGRAPHY_TIMEOUT"); raw != "" {
		cfg.BibliographyTimeout, err = time.ParseDuration(raw)
		if err != nil || cfg.BibliographyTimeout < time.Second || cfg.BibliographyTimeout > time.Minute {
			return Config{}, fmt.Errorf("BIBLIOGRAPHY_TIMEOUT must be between 1s and 1m")
		}
	}
	if cfg.PDFOCRMode != "auto" && cfg.PDFOCRMode != "always" && cfg.PDFOCRMode != "disabled" {
		return Config{}, fmt.Errorf("PDF_OCR_MODE must be auto, always, or disabled")
	}
	if raw := os.Getenv("PDF_OCR_MAX_PAGES"); raw != "" {
		cfg.PDFOCRMaxPages, err = strconv.Atoi(raw)
		if err != nil || cfg.PDFOCRMaxPages < 1 || cfg.PDFOCRMaxPages > 5000 {
			return Config{}, fmt.Errorf("PDF_OCR_MAX_PAGES must be between 1 and 5000")
		}
	}
	if raw := os.Getenv("PDF_OCR_DPI"); raw != "" {
		cfg.PDFOCRDPI, err = strconv.Atoi(raw)
		if err != nil || cfg.PDFOCRDPI < 100 || cfg.PDFOCRDPI > 400 {
			return Config{}, fmt.Errorf("PDF_OCR_DPI must be between 100 and 400")
		}
	}
	if raw := os.Getenv("MOBI_CONVERSION_TIMEOUT"); raw != "" {
		cfg.MOBIConversionTimeout, err = time.ParseDuration(raw)
		if err != nil || cfg.MOBIConversionTimeout < time.Second || cfg.MOBIConversionTimeout > 30*time.Minute {
			return Config{}, fmt.Errorf("MOBI_CONVERSION_TIMEOUT must be between 1s and 30m")
		}
	}
	if cfg.MOBIConverterBinary == "" {
		return Config{}, fmt.Errorf("MOBI_CONVERTER_BIN is required")
	}
	if cfg.OIDCIssuerURL != "" {
		if cfg.OIDCClientID == "" || cfg.OIDCClientSecret == "" || cfg.OIDCRedirectURL == "" {
			return Config{}, fmt.Errorf("OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URL are required when OIDC is enabled")
		}
		if err := validateAbsoluteHTTPURL(cfg.OIDCIssuerURL); err != nil {
			return Config{}, fmt.Errorf("OIDC_ISSUER_URL: %w", err)
		}
		if err := validateAbsoluteHTTPURL(cfg.OIDCRedirectURL); err != nil {
			return Config{}, fmt.Errorf("OIDC_REDIRECT_URL: %w", err)
		}
	}
	if cfg.LDAPURL != "" {
		ldapURL, parseErr := url.Parse(cfg.LDAPURL)
		if parseErr != nil || (ldapURL.Scheme != "ldap" && ldapURL.Scheme != "ldaps") || ldapURL.Host == "" {
			return Config{}, fmt.Errorf("LDAP_URL must be an absolute ldap:// or ldaps:// URL")
		}
		if ldapURL.Scheme == "ldaps" && cfg.LDAPStartTLS {
			return Config{}, fmt.Errorf("LDAP_START_TLS must be false when LDAP_URL uses ldaps://")
		}
		if cfg.LDAPBaseDN == "" || !strings.Contains(cfg.LDAPUserFilter, "{username}") {
			return Config{}, fmt.Errorf("LDAP_BASE_DN and an LDAP_USER_FILTER containing {username} are required when LDAP is enabled")
		}
	}
	if cfg.PublicAccess {
		publicURL, parseErr := url.Parse(cfg.PublicURL)
		if parseErr != nil || publicURL.Scheme != "https" || publicURL.Hostname() == "" {
			return Config{}, fmt.Errorf("PUBLIC_URL must be an absolute HTTPS URL when PUBLIC_ACCESS=true")
		}
		if !cfg.CookieSecure || cfg.TrustedProxyCIDR == "" || len(cfg.AllowedHosts) == 0 {
			return Config{}, fmt.Errorf("PUBLIC_ACCESS requires COOKIE_SECURE=true, TRUSTED_PROXY_CIDR and ALLOWED_HOSTS")
		}
		if !containsFold(cfg.AllowedHosts, publicURL.Host) && !containsFold(cfg.AllowedHosts, publicURL.Hostname()) {
			return Config{}, fmt.Errorf("ALLOWED_HOSTS must include the PUBLIC_URL host")
		}
	}

	return cfg, nil
}

func validateAbsoluteHTTPURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("must be an absolute HTTP(S) URL")
	}
	return nil
}

func splitCSV(raw string) []string {
	values := make([]string, 0)
	for _, value := range strings.Split(raw, ",") {
		if value = strings.TrimSpace(value); value != "" {
			values = append(values, value)
		}
	}
	return values
}

func containsFold(values []string, expected string) bool {
	for _, value := range values {
		if strings.EqualFold(value, expected) {
			return true
		}
	}
	return false
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envOrIfUnset(key, fallback string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return fallback
}
