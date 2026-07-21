package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"peufmreader/internal/bibliography"
	"peufmreader/internal/bibliographyjobs"
	"peufmreader/internal/calibre"
	"peufmreader/internal/classification"
	"peufmreader/internal/config"
	"peufmreader/internal/database"
	"peufmreader/internal/externalauth"
	"peufmreader/internal/httpapi"
	"peufmreader/internal/importinbox"
	"peufmreader/internal/importing"
	"peufmreader/internal/jobs"
	"peufmreader/internal/library"
	"peufmreader/internal/mobiconvert"
	"peufmreader/internal/pdfassets"
	"peufmreader/internal/store"
	"peufmreader/internal/watchlibrary"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		healthcheck()
		return
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := openDatabaseWithRetry(ctx, cfg.DatabaseURL, logger)
	if err != nil {
		logger.Error("database startup failed", "error", err)
		os.Exit(1)
	}
	defer pool.Close()
	if err := database.Migrate(ctx, pool); err != nil {
		logger.Error("database migration failed", "error", err)
		os.Exit(1)
	}

	dataStore := store.New(pool)
	if err := dataStore.EnsureClassificationRules(ctx, classification.DefaultRules()); err != nil {
		logger.Error("classification rule setup failed", "error", err)
		os.Exit(1)
	}
	if err := dataStore.EnsureAdmin(ctx, cfg.AdminUsername, cfg.AdminPassword); err != nil {
		logger.Error("initial admin setup failed", "error", err)
		os.Exit(1)
	}
	enabledBibliographySources := make(map[string]bool)
	for _, provider := range strings.Split(cfg.BibliographyProviders, ",") {
		enabledBibliographySources[strings.TrimSpace(provider)] = true
	}
	defaultBibliographyTimeoutMS := int(cfg.BibliographyTimeout.Milliseconds())
	if err := dataStore.EnsureBibliographySources(ctx, []store.BibliographySourceDefault{
		{Provider: "douban", Enabled: enabledBibliographySources["douban"], BaseURL: cfg.DoubanBaseURL, Priority: 10, TimeoutMS: defaultBibliographyTimeoutMS, MaxResults: 5},
		{Provider: "openlibrary", Enabled: enabledBibliographySources["openlibrary"], BaseURL: cfg.OpenLibraryBaseURL, Priority: 20, TimeoutMS: defaultBibliographyTimeoutMS, MaxResults: 5},
		{Provider: "google-books", Enabled: enabledBibliographySources["google-books"], BaseURL: cfg.GoogleBooksBaseURL, Priority: 30, TimeoutMS: defaultBibliographyTimeoutMS, MaxResults: 5},
	}); err != nil {
		logger.Error("bibliography source setup failed", "error", err)
		os.Exit(1)
	}
	bibliographyService := bibliography.NewDynamicService(
		func(ctx context.Context, automaticOnly bool) ([]bibliography.SourceConfig, error) {
			sources, loadErr := dataStore.ListEnabledBibliographySources(ctx, automaticOnly)
			if loadErr != nil {
				return nil, loadErr
			}
			configs := make([]bibliography.SourceConfig, 0, len(sources))
			for _, source := range sources {
				configs = append(configs, bibliography.SourceConfig{
					ID: source.ID, Provider: source.Provider, BaseURL: source.BaseURL, Priority: source.Priority,
					Timeout: time.Duration(source.TimeoutMS) * time.Millisecond, MaxResults: source.MaxResults,
				})
			}
			return configs, nil
		},
		func(ctx context.Context, sourceID int64, success bool, latency time.Duration, errorMessage string) error {
			return dataStore.RecordBibliographySourceCheck(ctx, sourceID, success, latency, errorMessage)
		},
		cfg.GoogleBooksAPIKey,
	)
	libraryManager, err := library.NewManager(cfg.LibraryRoot, cfg.StagingRoot, cfg.CacheRoot, cfg.MaxUploadBytes)
	if err != nil {
		logger.Error("library setup failed", "error", err)
		os.Exit(1)
	}
	kindleConverter, err := mobiconvert.New(cfg.CacheRoot, cfg.MOBIConverterBinary, cfg.MOBIConversionTimeout)
	if err != nil {
		logger.Error("MOBI/AZW3 converter setup failed", "error", err)
		os.Exit(1)
	}
	importService := importing.New(dataStore, libraryManager, kindleConverter)
	importService.SetPostImportHook(func(ctx context.Context, userID int64, book store.BookFile) error {
		return bibliographyjobs.EnqueueIfConfigured(ctx, dataStore, userID, book)
	})
	importManager, err := importinbox.NewManager(cfg.ImportRoot)
	if err != nil {
		logger.Error("import inbox setup failed", "error", err)
		os.Exit(1)
	}
	adminUser, found, err := dataStore.GetActiveUserByUsername(ctx, cfg.AdminUsername)
	if err != nil || !found {
		logger.Error("import inbox actor setup failed", "found", found, "error", err)
		os.Exit(1)
	}
	var watchedLibraryManager *watchlibrary.Manager
	if cfg.WatchLibraryEnabled {
		watchedLibraryManager, err = watchlibrary.NewManager(cfg.WatchLibraryRoot)
		if err != nil {
			logger.Error("read-only watched library setup failed", "error", err)
			os.Exit(1)
		}
	}
	calibreScanner := calibre.NewScanner(cfg.CalibreRoot)
	pdfProcessor := pdfassets.NewProcessor(pdfassets.Config{
		OCRMode: cfg.PDFOCRMode, OCRLanguages: cfg.PDFOCRLanguages,
		OCRMaxPages: cfg.PDFOCRMaxPages, OCRDPI: cfg.PDFOCRDPI,
	})
	if queued, enqueueErr := pdfassets.EnqueueMissing(ctx, dataStore, 10000); enqueueErr != nil {
		logger.Warn("PDF asset backfill failed", "error", enqueueErr)
	} else if queued > 0 {
		logger.Info("PDF asset jobs queued", "count", queued)
	}
	workerID := fmt.Sprintf("%s-%d", hostname(), os.Getpid())
	handlers := map[string]jobs.Handler{
		calibre.ImportJobKind:    calibre.ImportHandler(calibreScanner, importService),
		importinbox.JobKind:      importinbox.Handler(importManager, importService),
		pdfassets.JobKind:        pdfassets.Handler(dataStore, libraryManager, pdfProcessor),
		bibliographyjobs.JobKind: bibliographyjobs.Handler(dataStore, bibliographyService),
	}
	if watchedLibraryManager != nil {
		handlers[watchlibrary.JobKind] = watchlibrary.Handler(watchedLibraryManager, importService)
	}
	worker := jobs.New(dataStore, handlers, logger, workerID)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		worker.Run(ctx)
	}()
	inboxWatcher := importinbox.NewWatcher(importManager, dataStore, adminUser.ID, cfg.ImportScanInterval, cfg.ImportStableAge, logger)
	go inboxWatcher.Run(ctx)
	if watchedLibraryManager != nil {
		watchedLibraryWatcher := watchlibrary.NewWatcher(
			watchedLibraryManager, dataStore, adminUser.ID,
			cfg.WatchLibraryScanEvery, cfg.WatchLibraryStableAge, logger,
		)
		go watchedLibraryWatcher.Run(ctx)
		logger.Info("read-only watched library enabled", "path", cfg.WatchLibraryLabel)
	}

	advisor := classification.NewAdvisor(cfg.AIProvider, cfg.AIBaseURL, cfg.AIModel, cfg.AIAPIKey, cfg.AITimeout)
	importSources := []httpapi.ImportSource{
		{ID: "browser-upload", Name: "网页批量上传", Mode: "upload", Enabled: true, MaxFileBytes: cfg.MaxUploadBytes},
		{
			ID: "moving-inbox", Name: "移动导入箱", Mode: "move", Enabled: true,
			Path:                strings.TrimRight(cfg.ImportRootLabel, "/\\") + "/inbox",
			ScanIntervalSeconds: int64(cfg.ImportScanInterval.Seconds()), StableAgeSeconds: int64(cfg.ImportStableAge.Seconds()),
		},
		{
			ID: "watched-library", Name: "只读监控目录", Mode: "copy", Enabled: cfg.WatchLibraryEnabled,
			Path:                cfg.WatchLibraryLabel,
			ScanIntervalSeconds: int64(cfg.WatchLibraryScanEvery.Seconds()), StableAgeSeconds: int64(cfg.WatchLibraryStableAge.Seconds()),
		},
	}
	api := httpapi.New(dataStore, libraryManager, kindleConverter, importService, calibreScanner, bibliographyService, importSources, advisor, cfg.WebRoot, cfg.CookieSecure, cfg.SessionTTL, cfg.MaxUploadBytes, cfg.TrustedProxyCIDR, logger)
	externalAuth, err := externalauth.New(ctx, externalauth.Config{
		OIDCIssuerURL: cfg.OIDCIssuerURL, OIDCClientID: cfg.OIDCClientID, OIDCClientSecret: cfg.OIDCClientSecret,
		OIDCRedirectURL: cfg.OIDCRedirectURL, OIDCUsernameClaim: cfg.OIDCUsernameClaim,
		OIDCGroupsClaim: cfg.OIDCGroupsClaim, OIDCAdminGroup: cfg.OIDCAdminGroup,
		LDAPURL: cfg.LDAPURL, LDAPStartTLS: cfg.LDAPStartTLS, LDAPBaseDN: cfg.LDAPBaseDN,
		LDAPBindDN: cfg.LDAPBindDN, LDAPBindPassword: cfg.LDAPBindPassword,
		LDAPUserFilter: cfg.LDAPUserFilter, LDAPUsernameAttribute: cfg.LDAPUsernameAttribute,
		LDAPAdminGroupDN: cfg.LDAPAdminGroupDN,
	})
	if err != nil {
		logger.Error("external authentication setup failed", "error", err)
		os.Exit(1)
	}
	api.ConfigureExternalAuth(externalAuth)
	api.ConfigurePublicSecurity(cfg.PublicAccess, cfg.AllowedHosts)
	server := &http.Server{
		Addr:              cfg.Address,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		logger.Info("PEUFMReader listening", "address", cfg.Address)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP server failed", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
	}
	select {
	case <-workerDone:
	case <-shutdownCtx.Done():
		logger.Warn("background worker did not stop before shutdown deadline")
	}
}

func hostname() string {
	value, err := os.Hostname()
	if err != nil || value == "" {
		return "peufmreader"
	}
	return value
}

func healthcheck() {
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get("http://127.0.0.1:8080/healthz")
	if err != nil || response.StatusCode != http.StatusOK {
		os.Exit(1)
	}
	_ = response.Body.Close()
}

func openDatabaseWithRetry(ctx context.Context, databaseURL string, logger *slog.Logger) (*pgxpool.Pool, error) {
	var lastErr error
	for attempt := 1; attempt <= 15; attempt++ {
		pool, err := database.Open(ctx, databaseURL)
		if err == nil {
			return pool, nil
		}
		lastErr = err
		logger.Warn("database not ready", "attempt", attempt, "error", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return nil, lastErr
}
