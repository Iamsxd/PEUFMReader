package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"peufmreader/internal/bibliography"
	"peufmreader/internal/calibre"
	"peufmreader/internal/classification"
	"peufmreader/internal/importing"
	"peufmreader/internal/library"
	"peufmreader/internal/store"
)

const sessionCookieName = "peufm_session"

type API struct {
	store          *store.Store
	library        *library.Manager
	webRoot        string
	cookieSecure   bool
	sessionTTL     time.Duration
	maxUploadBytes int64
	advisor        *classification.Advisor
	importer       *importing.Service
	calibre        *calibre.Scanner
	bibliography   *bibliography.Service
	logger         *slog.Logger
	mux            *http.ServeMux
}

type contextKey string

const sessionContextKey contextKey = "session"

func New(store *store.Store, libraryManager *library.Manager, importer *importing.Service, calibreScanner *calibre.Scanner, bibliographyService *bibliography.Service, advisor *classification.Advisor, webRoot string, cookieSecure bool, sessionTTL time.Duration, maxUploadBytes int64, logger *slog.Logger) *API {
	api := &API{
		store:          store,
		library:        libraryManager,
		webRoot:        webRoot,
		cookieSecure:   cookieSecure,
		sessionTTL:     sessionTTL,
		maxUploadBytes: maxUploadBytes,
		advisor:        advisor,
		importer:       importer,
		calibre:        calibreScanner,
		bibliography:   bibliographyService,
		logger:         logger,
		mux:            http.NewServeMux(),
	}
	api.routes()
	return api
}

func (a *API) Handler() http.Handler {
	return a.securityHeaders(a.requestLog(a.mux))
}

func (a *API) routes() {
	a.mux.HandleFunc("GET /healthz", a.health)
	a.mux.HandleFunc("POST /api/v1/auth/login", a.login)
	a.mux.Handle("GET /api/v1/auth/me", a.requireAuth(http.HandlerFunc(a.me), "", false))
	a.mux.Handle("POST /api/v1/auth/logout", a.requireAuth(http.HandlerFunc(a.logout), "", true))
	a.mux.Handle("GET /api/v1/users", a.requireAuth(http.HandlerFunc(a.listUsers), "admin", false))
	a.mux.Handle("POST /api/v1/users", a.requireAuth(http.HandlerFunc(a.createUser), "admin", true))
	a.mux.Handle("GET /api/v1/book-files", a.requireAuth(http.HandlerFunc(a.listBookFiles), "", false))
	a.mux.Handle("POST /api/v1/book-files", a.requireAuth(http.HandlerFunc(a.uploadBookFile), "admin", true))
	a.mux.Handle("GET /api/v1/book-files/{id}/content", a.requireAuth(http.HandlerFunc(a.bookContent), "", false))
	a.mux.Handle("GET /api/v1/book-files/{id}/cover", a.requireAuth(http.HandlerFunc(a.bookCover), "", false))
	a.mux.Handle("GET /api/v1/book-files/{id}/progress", a.requireAuth(http.HandlerFunc(a.getProgress), "", false))
	a.mux.Handle("PUT /api/v1/book-files/{id}/progress", a.requireAuth(http.HandlerFunc(a.saveProgress), "", true))
	a.mux.Handle("POST /api/v1/book-files/{id}/reading-sessions", a.requireAuth(http.HandlerFunc(a.startReadingSession), "", true))
	a.mux.Handle("PATCH /api/v1/reading-sessions/{id}", a.requireAuth(http.HandlerFunc(a.advanceReadingSession), "", true))
	a.mux.Handle("GET /api/v1/categories", a.requireAuth(http.HandlerFunc(a.listCategories), "", false))
	a.mux.Handle("GET /api/v1/review-queue", a.requireAuth(http.HandlerFunc(a.listReviewQueue), "admin", false))
	a.mux.Handle("GET /api/v1/editions/{id}/review", a.requireAuth(http.HandlerFunc(a.getEditionReview), "admin", false))
	a.mux.Handle("PUT /api/v1/editions/{id}/review", a.requireAuth(http.HandlerFunc(a.reviewEdition), "admin", true))
	a.mux.Handle("POST /api/v1/editions/{id}/ai-classify", a.requireAuth(http.HandlerFunc(a.aiClassifyEdition), "admin", true))
	a.mux.Handle("POST /api/v1/editions/{id}/bibliography-search", a.requireAuth(http.HandlerFunc(a.searchBibliography), "admin", true))
	a.mux.Handle("GET /api/v1/import-jobs", a.requireAuth(http.HandlerFunc(a.listImportJobs), "admin", false))
	a.mux.Handle("GET /api/v1/background-jobs", a.requireAuth(http.HandlerFunc(a.listBackgroundJobs), "admin", false))
	a.mux.Handle("POST /api/v1/background-jobs/{id}/retry", a.requireAuth(http.HandlerFunc(a.retryBackgroundJob), "admin", true))
	a.mux.Handle("GET /api/v1/calibre/preview", a.requireAuth(http.HandlerFunc(a.previewCalibre), "admin", false))
	a.mux.Handle("POST /api/v1/calibre/import", a.requireAuth(http.HandlerFunc(a.importCalibre), "admin", true))
	a.mux.HandleFunc("GET /", a.serveFrontend)
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.store.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "database is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := readJSON(w, r, &input, 64<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	user, valid, err := a.store.Authenticate(r.Context(), input.Username, input.Password)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !valid {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "invalid username or password")
		return
	}
	rawToken, err := randomToken(32)
	if err != nil {
		a.internalError(w, err)
		return
	}
	csrfToken, err := randomToken(24)
	if err != nil {
		a.internalError(w, err)
		return
	}
	expiresAt := time.Now().UTC().Add(a.sessionTTL)
	if err := a.store.CreateSession(r.Context(), rawToken, csrfToken, user.ID, expiresAt); err != nil {
		a.internalError(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    rawToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   a.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
		MaxAge:   int(time.Until(expiresAt).Seconds()),
	})
	writeJSON(w, http.StatusOK, map[string]any{"user": user, "csrfToken": csrfToken})
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	session := sessionFromContext(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"user": session.User, "csrfToken": session.CSRFToken})
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		_ = a.store.DeleteSession(r.Context(), cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   a.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
		Expires:  time.Unix(1, 0),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := a.store.ListUsers(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": users})
}

func (a *API) createUser(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}
	if err := readJSON(w, r, &input, 64<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if len(input.Password) < 12 {
		writeError(w, http.StatusBadRequest, "weak_password", "password must contain at least 12 characters")
		return
	}
	user, err := a.store.CreateUser(r.Context(), input.Username, input.Password, input.Role)
	if err != nil {
		writeError(w, http.StatusConflict, "user_not_created", "username already exists or input is invalid")
		return
	}
	writeJSON(w, http.StatusCreated, user)
}

func (a *API) listBookFiles(w http.ResponseWriter, r *http.Request) {
	books, err := a.store.ListCatalogBooks(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	for index := range books {
		a.decorateBook(&books[index])
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": books})
}

func (a *API) uploadBookFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, a.maxUploadBytes+(2<<20))
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_upload", "upload is too large or malformed")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing_file", "multipart field 'file' is required")
		return
	}
	defer file.Close()
	userSession := sessionFromContext(r.Context())
	result, err := a.importer.Import(r.Context(), userSession.User.ID, header.Filename, header.Filename, file, nil)
	if err != nil {
		switch {
		case errors.Is(err, library.ErrUnsupportedFormat):
			writeError(w, http.StatusUnsupportedMediaType, "unsupported_format", "only valid PDF and EPUB files are supported")
		case errors.Is(err, library.ErrUploadTooLarge):
			writeError(w, http.StatusRequestEntityTooLarge, "upload_too_large", "file exceeds the configured upload limit")
		case errors.Is(err, importing.ErrMetadataExtraction):
			writeError(w, http.StatusUnprocessableEntity, "metadata_extraction_failed", "ebook metadata could not be extracted")
		default:
			a.internalError(w, err)
		}
		return
	}
	status := http.StatusCreated
	if result.Duplicate {
		status = http.StatusOK
	}
	a.decorateBook(&result.Book)
	writeJSON(w, status, map[string]any{"bookFile": result.Book, "duplicate": result.Duplicate, "importJobId": result.ImportJobID})
}

func (a *API) decorateBook(book *store.BookFile) {
	if book.CoverPath != "" {
		book.CoverURL = fmt.Sprintf("/api/v1/book-files/%d/cover", book.ID)
	}
}

func (a *API) bookContent(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	book, found, err := a.store.GetBookFile(r.Context(), id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "book_not_found", "book file not found")
		return
	}
	absolutePath, err := a.library.Resolve(book.StoragePath)
	if err != nil {
		a.internalError(w, err)
		return
	}
	file, err := os.Open(absolutePath)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusGone, "managed_file_missing", "managed file is missing")
		return
	}
	if err != nil {
		a.internalError(w, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		a.internalError(w, err)
		return
	}
	w.Header().Set("Content-Type", book.MIMEType)
	w.Header().Set("Content-Disposition", "inline; filename*=UTF-8''"+url.PathEscape(book.OriginalFilename))
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeContent(w, r, book.OriginalFilename, info.ModTime(), file)
}

func (a *API) bookCover(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	book, found, err := a.store.GetCatalogBook(r.Context(), id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found || book.CoverPath == "" {
		writeError(w, http.StatusNotFound, "cover_not_found", "book cover not found")
		return
	}
	absolutePath, err := a.library.ResolveCover(book.CoverPath)
	if err != nil {
		a.internalError(w, err)
		return
	}
	file, err := os.Open(absolutePath)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusGone, "cover_missing", "cached cover is missing")
		return
	}
	if err != nil {
		a.internalError(w, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		a.internalError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, filepath.Base(absolutePath), info.ModTime(), file)
}

func (a *API) listCategories(w http.ResponseWriter, r *http.Request) {
	categories, err := a.store.ListCategories(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": categories})
}

func (a *API) listReviewQueue(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListReviewQueue(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) getEditionReview(w http.ResponseWriter, r *http.Request) {
	editionID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	item, found, err := a.store.GetReviewItem(r.Context(), editionID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "edition_not_found", "edition not found")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) reviewEdition(w http.ResponseWriter, r *http.Request) {
	editionID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input struct {
		Title         string   `json:"title"`
		Authors       []string `json:"authors"`
		PublishedYear *int     `json:"publishedYear"`
		Language      string   `json:"language"`
		ISBN          string   `json:"isbn"`
		Publisher     string   `json:"publisher"`
		Description   string   `json:"description"`
		CategorySlugs []string `json:"categorySlugs"`
	}
	if err := readJSON(w, r, &input, 128<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_review", err.Error())
		return
	}
	input.Title = strings.TrimSpace(input.Title)
	if input.Title == "" || len(input.Title) > 500 || len(input.Authors) > 32 || len(input.CategorySlugs) > 8 || len(input.Description) > 64<<10 {
		writeError(w, http.StatusBadRequest, "invalid_review", "metadata fields exceed allowed limits")
		return
	}
	if input.PublishedYear != nil && (*input.PublishedYear < 0 || *input.PublishedYear > 9999) {
		writeError(w, http.StatusBadRequest, "invalid_review", "publishedYear is invalid")
		return
	}
	userSession := sessionFromContext(r.Context())
	item, err := a.store.ReviewEdition(r.Context(), editionID, userSession.User.ID, store.ReviewInput{
		Title: input.Title, Authors: input.Authors, PublishedYear: input.PublishedYear, Language: strings.TrimSpace(input.Language),
		ISBN: strings.TrimSpace(input.ISBN), Publisher: strings.TrimSpace(input.Publisher), Description: strings.TrimSpace(input.Description),
		CategorySlugs: input.CategorySlugs,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "edition_not_found", "edition not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "review_not_saved", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) aiClassifyEdition(w http.ResponseWriter, r *http.Request) {
	if a.advisor == nil {
		writeError(w, http.StatusConflict, "ai_not_configured", "AI classification is not configured")
		return
	}
	editionID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	book, found, err := a.store.EditionMetadata(r.Context(), editionID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "edition_not_found", "edition not found")
		return
	}
	categories, err := a.store.ListCategories(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	options := make([]classification.CategoryOption, 0, len(categories))
	for _, category := range categories {
		options = append(options, classification.CategoryOption{Slug: category.Slug, Name: category.Name})
	}
	suggestions, err := a.advisor.Suggest(r.Context(), book, options)
	if err != nil {
		a.logger.Warn("AI classification failed", "edition_id", editionID, "error", err)
		writeError(w, http.StatusBadGateway, "ai_classification_failed", "AI classification provider failed")
		return
	}
	if err := a.store.AddClassificationSuggestions(r.Context(), editionID, suggestions); err != nil {
		a.internalError(w, err)
		return
	}
	item, _, err := a.store.GetReviewItem(r.Context(), editionID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) searchBibliography(w http.ResponseWriter, r *http.Request) {
	if !a.bibliography.Available() {
		writeError(w, http.StatusConflict, "bibliography_not_configured", "external bibliography search is not configured")
		return
	}
	editionID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	book, found, err := a.store.EditionMetadata(r.Context(), editionID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "edition_not_found", "edition not found")
		return
	}
	result, err := a.bibliography.Search(r.Context(), bibliography.Query{
		Title: book.Title, Authors: book.Authors, ISBN: book.ISBN, Language: book.Language,
	})
	if err != nil {
		a.logger.Warn("bibliography search failed", "edition_id", editionID, "error", err)
		writeError(w, http.StatusBadGateway, "bibliography_search_failed", err.Error())
		return
	}
	if err := a.store.AddBibliographySuggestions(r.Context(), editionID, result.Matches); err != nil {
		a.internalError(w, err)
		return
	}
	item, _, err := a.store.GetReviewItem(r.Context(), editionID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"matches": result.Matches, "warnings": result.Warnings, "reviewItem": item})
}

func (a *API) listImportJobs(w http.ResponseWriter, r *http.Request) {
	jobs, err := a.store.ListImportJobs(r.Context(), 50)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": jobs})
}

func (a *API) listBackgroundJobs(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListBackgroundJobs(r.Context(), 100)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) retryBackgroundJob(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	job, err := a.store.RetryBackgroundJob(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusConflict, "job_not_retryable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (a *API) previewCalibre(w http.ResponseWriter, r *http.Request) {
	preview, err := a.calibre.Preview(200)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "calibre_scan_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func (a *API) importCalibre(w http.ResponseWriter, r *http.Request) {
	var input struct {
		SourcePaths []string `json:"sourcePaths"`
	}
	if err := readJSON(w, r, &input, 2<<20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	preview, err := a.calibre.Preview(10000)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "calibre_scan_failed", err.Error())
		return
	}
	requested := make(map[string]struct{}, len(input.SourcePaths))
	for _, path := range input.SourcePaths {
		requested[path] = struct{}{}
	}
	userID := sessionFromContext(r.Context()).User.ID
	queued, existing := 0, 0
	jobIDs := make([]int64, 0, min(preview.Total, 200))
	for _, record := range preview.Books {
		if len(requested) > 0 {
			if _, ok := requested[record.SourcePath]; !ok {
				continue
			}
		}
		job, created, enqueueErr := a.store.EnqueueBackgroundJob(
			r.Context(), calibre.ImportJobKind, record.SourcePath,
			calibre.ImportPayload{SourcePath: record.SourcePath}, &userID, nil, 3,
		)
		if enqueueErr != nil {
			a.internalError(w, enqueueErr)
			return
		}
		if created {
			queued++
		} else {
			existing++
		}
		if len(jobIDs) < 200 {
			jobIDs = append(jobIDs, job.ID)
		}
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"queued": queued, "existing": existing, "jobIds": jobIDs})
}

func (a *API) getProgress(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	session := sessionFromContext(r.Context())
	state, err := a.store.GetReadingState(r.Context(), session.User.ID, id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (a *API) saveProgress(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input struct {
		Position        json.RawMessage `json:"position"`
		OverallProgress float64         `json:"overallProgress"`
		Status          string          `json:"status"`
	}
	if err := readJSON(w, r, &input, 16<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_progress", err.Error())
		return
	}
	if !validPosition(input.Position) || input.OverallProgress < 0 || input.OverallProgress > 1 || !validReadingStatus(input.Status) {
		writeError(w, http.StatusBadRequest, "invalid_progress", "position, progress or status is invalid")
		return
	}
	if _, found, err := a.store.GetBookFile(r.Context(), id); err != nil {
		a.internalError(w, err)
		return
	} else if !found {
		writeError(w, http.StatusNotFound, "book_not_found", "book file not found")
		return
	}
	session := sessionFromContext(r.Context())
	state, err := a.store.SaveReadingState(r.Context(), session.User.ID, id, input.Position, input.OverallProgress, input.Status)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (a *API) startReadingSession(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	if _, found, err := a.store.GetBookFile(r.Context(), id); err != nil {
		a.internalError(w, err)
		return
	} else if !found {
		writeError(w, http.StatusNotFound, "book_not_found", "book file not found")
		return
	}
	userSession := sessionFromContext(r.Context())
	readingSession, err := a.store.StartReadingSession(r.Context(), userSession.User.ID, id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, readingSession)
}

func (a *API) advanceReadingSession(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input struct {
		ActiveSeconds int64  `json:"activeSeconds"`
		Action        string `json:"action"`
	}
	if err := readJSON(w, r, &input, 16<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_session_update", err.Error())
		return
	}
	if input.ActiveSeconds < 0 || input.ActiveSeconds > 60 || (input.Action != "heartbeat" && input.Action != "finish") {
		writeError(w, http.StatusBadRequest, "invalid_session_update", "invalid activeSeconds or action")
		return
	}
	userSession := sessionFromContext(r.Context())
	readingSession, err := a.store.AdvanceReadingSession(r.Context(), userSession.User.ID, id, input.ActiveSeconds, input.Action == "finish")
	if err != nil {
		writeError(w, http.StatusNotFound, "reading_session_not_found", "reading session not found")
		return
	}
	writeJSON(w, http.StatusOK, readingSession)
}

func (a *API) requireAuth(next http.Handler, requiredRole string, csrfRequired bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookieName)
		if err != nil || cookie.Value == "" {
			writeError(w, http.StatusUnauthorized, "authentication_required", "authentication required")
			return
		}
		session, found, err := a.store.GetSession(r.Context(), cookie.Value)
		if err != nil {
			a.internalError(w, err)
			return
		}
		if !found {
			writeError(w, http.StatusUnauthorized, "session_expired", "session is invalid or expired")
			return
		}
		if requiredRole != "" && session.User.Role != requiredRole {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient permissions")
			return
		}
		if csrfRequired && r.Header.Get("X-CSRF-Token") != session.CSRFToken {
			writeError(w, http.StatusForbidden, "invalid_csrf_token", "CSRF token is missing or invalid")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionContextKey, session)))
	})
}

func sessionFromContext(ctx context.Context) store.Session {
	session, _ := ctx.Value(sessionContextKey).(store.Session)
	return session
}

func (a *API) serveFrontend(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "not_found", "endpoint not found")
		return
	}
	root, err := filepath.Abs(a.webRoot)
	if err != nil {
		a.internalError(w, err)
		return
	}
	relative := strings.TrimPrefix(filepath.Clean(filepath.FromSlash(r.URL.Path)), string(filepath.Separator))
	if relative == "." || relative == "" {
		relative = "index.html"
	}
	requested, err := library.SecureResolve(root, relative)
	if err == nil {
		if info, statErr := os.Stat(requested); statErr == nil && !info.IsDir() {
			http.ServeFile(w, r, requested)
			return
		}
	}
	indexPath := filepath.Join(root, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		writeError(w, http.StatusNotFound, "frontend_not_built", "frontend assets are not available")
		return
	}
	http.ServeFile(w, r, indexPath)
}

func (a *API) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

func (a *API) requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		a.logger.Info("http request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(started))
	})
}

func (a *API) internalError(w http.ResponseWriter, err error) {
	a.logger.Error("request failed", "error", err)
	writeError(w, http.StatusInternalServerError, "internal_error", "internal server error")
}

func readJSON(w http.ResponseWriter, r *http.Request, target any, maxBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("request body must contain one JSON object")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func parseID(w http.ResponseWriter, value string) (int64, bool) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "invalid_id", "id must be a positive integer")
		return 0, false
	}
	return id, true
}

func randomToken(bytesCount int) (string, error) {
	value := make([]byte, bytesCount)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func validPosition(raw json.RawMessage) bool {
	if len(raw) == 0 || len(raw) > 8<<10 {
		return false
	}
	var value map[string]any
	return json.Unmarshal(raw, &value) == nil && value != nil
}

func validReadingStatus(value string) bool {
	switch value {
	case "unread", "reading", "finished", "paused", "abandoned":
		return true
	default:
		return false
	}
}
