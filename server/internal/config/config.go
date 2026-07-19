package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Address          string
	DatabaseURL      string
	LibraryRoot      string
	StagingRoot      string
	CacheRoot        string
	WebRoot          string
	AdminUsername    string
	AdminPassword    string
	CookieSecure     bool
	SessionTTL       time.Duration
	MaxUploadBytes   int64
	TrustedProxyCIDR string
	AIProvider       string
	AIBaseURL        string
	AIModel          string
	AIAPIKey         string
	AITimeout        time.Duration
}

func Load() (Config, error) {
	cfg := Config{
		Address:          envOr("ADDRESS", ":8080"),
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		LibraryRoot:      envOr("LIBRARY_ROOT", "/data/library"),
		StagingRoot:      envOr("STAGING_ROOT", "/data/staging"),
		CacheRoot:        envOr("CACHE_ROOT", "/data/cache"),
		WebRoot:          envOr("WEB_ROOT", "/app/web"),
		AdminUsername:    strings.ToLower(strings.TrimSpace(envOr("ADMIN_USERNAME", "admin"))),
		AdminPassword:    os.Getenv("ADMIN_PASSWORD"),
		SessionTTL:       30 * 24 * time.Hour,
		MaxUploadBytes:   500 << 20,
		TrustedProxyCIDR: os.Getenv("TRUSTED_PROXY_CIDR"),
		AIProvider:       strings.ToLower(strings.TrimSpace(os.Getenv("AI_PROVIDER"))),
		AIBaseURL:        strings.TrimRight(strings.TrimSpace(os.Getenv("AI_BASE_URL")), "/"),
		AIModel:          strings.TrimSpace(os.Getenv("AI_MODEL")),
		AIAPIKey:         os.Getenv("AI_API_KEY"),
		AITimeout:        45 * time.Second,
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

	return cfg, nil
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
