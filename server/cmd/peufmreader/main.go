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
	"peufmreader/internal/calibre"
	"peufmreader/internal/classification"
	"peufmreader/internal/config"
	"peufmreader/internal/database"
	"peufmreader/internal/httpapi"
	"peufmreader/internal/importinbox"
	"peufmreader/internal/importing"
	"peufmreader/internal/jobs"
	"peufmreader/internal/library"
	"peufmreader/internal/pdfassets"
	"peufmreader/internal/store"
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
	if err := dataStore.EnsureAdmin(ctx, cfg.AdminUsername, cfg.AdminPassword); err != nil {
		logger.Error("initial admin setup failed", "error", err)
		os.Exit(1)
	}
	libraryManager, err := library.NewManager(cfg.LibraryRoot, cfg.StagingRoot, cfg.CacheRoot, cfg.MaxUploadBytes)
	if err != nil {
		logger.Error("library setup failed", "error", err)
		os.Exit(1)
	}
	importService := importing.New(dataStore, libraryManager)
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
	worker := jobs.New(dataStore, map[string]jobs.Handler{
		calibre.ImportJobKind: calibre.ImportHandler(calibreScanner, importService),
		importinbox.JobKind:   importinbox.Handler(importManager, importService),
		pdfassets.JobKind:     pdfassets.Handler(dataStore, libraryManager, pdfProcessor),
	}, logger, workerID)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		worker.Run(ctx)
	}()
	inboxWatcher := importinbox.NewWatcher(importManager, dataStore, adminUser.ID, cfg.ImportScanInterval, cfg.ImportStableAge, logger)
	go inboxWatcher.Run(ctx)

	advisor := classification.NewAdvisor(cfg.AIProvider, cfg.AIBaseURL, cfg.AIModel, cfg.AIAPIKey, cfg.AITimeout)
	bibliographyProviders := make([]bibliography.Provider, 0, 2)
	for _, provider := range strings.Split(cfg.BibliographyProviders, ",") {
		switch strings.TrimSpace(provider) {
		case "openlibrary":
			bibliographyProviders = append(bibliographyProviders, bibliography.NewOpenLibrary(cfg.OpenLibraryBaseURL, cfg.BibliographyTimeout))
		case "google-books":
			bibliographyProviders = append(bibliographyProviders, bibliography.NewGoogleBooks(cfg.GoogleBooksBaseURL, cfg.GoogleBooksAPIKey, cfg.BibliographyTimeout))
		}
	}
	bibliographyService := bibliography.NewService(bibliographyProviders...)
	api := httpapi.New(dataStore, libraryManager, importService, calibreScanner, bibliographyService, advisor, cfg.WebRoot, cfg.CookieSecure, cfg.SessionTTL, cfg.MaxUploadBytes, logger)
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
