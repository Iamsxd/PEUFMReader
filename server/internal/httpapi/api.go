package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"peufmreader/internal/bibliography"
	"peufmreader/internal/calibre"
	"peufmreader/internal/classification"
	"peufmreader/internal/importing"
	"peufmreader/internal/library"
	"peufmreader/internal/mobiconvert"
	"peufmreader/internal/pdfassets"
	"peufmreader/internal/store"
)

const sessionCookieName = "peufm_session"

var categorySlugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

type API struct {
	store          *store.Store
	library        *library.Manager
	converter      *mobiconvert.Converter
	webRoot        string
	cookieSecure   bool
	sessionTTL     time.Duration
	maxUploadBytes int64
	advisor        *classification.Advisor
	importer       *importing.Service
	calibre        *calibre.Scanner
	bibliography   *bibliography.Service
	importSources  []ImportSource
	logger         *slog.Logger
	loginLimiter   *loginLimiter
	trustedProxy   *net.IPNet
	mux            *http.ServeMux
}

type ImportSource struct {
	ID                  string `json:"id"`
	Name                string `json:"name"`
	Mode                string `json:"mode"`
	Enabled             bool   `json:"enabled"`
	Path                string `json:"path,omitempty"`
	ScanIntervalSeconds int64  `json:"scanIntervalSeconds,omitempty"`
	StableAgeSeconds    int64  `json:"stableAgeSeconds,omitempty"`
	MaxFileBytes        int64  `json:"maxFileBytes,omitempty"`
}

type contextKey string

const sessionContextKey contextKey = "session"

func New(store *store.Store, libraryManager *library.Manager, converter *mobiconvert.Converter, importer *importing.Service, calibreScanner *calibre.Scanner, bibliographyService *bibliography.Service, importSources []ImportSource, advisor *classification.Advisor, webRoot string, cookieSecure bool, sessionTTL time.Duration, maxUploadBytes int64, trustedProxyCIDR string, logger *slog.Logger) *API {
	var trustedProxy *net.IPNet
	if strings.TrimSpace(trustedProxyCIDR) != "" {
		_, trustedProxy, _ = net.ParseCIDR(trustedProxyCIDR)
	}
	api := &API{
		store:          store,
		library:        libraryManager,
		converter:      converter,
		webRoot:        webRoot,
		cookieSecure:   cookieSecure,
		sessionTTL:     sessionTTL,
		maxUploadBytes: maxUploadBytes,
		advisor:        advisor,
		importer:       importer,
		calibre:        calibreScanner,
		bibliography:   bibliographyService,
		importSources:  append([]ImportSource(nil), importSources...),
		logger:         logger,
		loginLimiter:   newLoginLimiter(),
		trustedProxy:   trustedProxy,
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
	a.mux.Handle("GET /api/v1/device-tokens", a.requireAuth(http.HandlerFunc(a.listDeviceTokens), "", false))
	a.mux.Handle("POST /api/v1/device-tokens", a.requireAuth(http.HandlerFunc(a.createDeviceToken), "", true))
	a.mux.Handle("DELETE /api/v1/device-tokens/{id}", a.requireAuth(http.HandlerFunc(a.revokeDeviceToken), "", true))
	a.mux.Handle("GET /opds", a.requireDeviceAuth(http.HandlerFunc(a.opdsCatalog)))
	a.mux.Handle("GET /opds/v1.2/catalog", a.requireDeviceAuth(http.HandlerFunc(a.opdsCatalog)))
	a.mux.Handle("GET /opds/books/{id}/download", a.requireDeviceAuth(http.HandlerFunc(a.bookContent)))
	a.mux.Handle("GET /opds/books/{id}/cover", a.requireDeviceAuth(http.HandlerFunc(a.bookCover)))
	a.mux.Handle("GET /api/koreader/users/auth", a.requireDeviceAuth(http.HandlerFunc(a.koReaderAuth)))
	a.mux.Handle("PUT /api/koreader/syncs/progress", a.requireDeviceAuth(http.HandlerFunc(a.saveKOReaderProgress)))
	a.mux.Handle("GET /api/koreader/syncs/progress/{document}", a.requireDeviceAuth(http.HandlerFunc(a.getKOReaderProgress)))
	a.mux.Handle("GET /api/kobo/v1/library/{id}/state", a.requireDeviceAuth(http.HandlerFunc(a.getKoboProgress)))
	a.mux.Handle("PUT /api/kobo/v1/library/{id}/state", a.requireDeviceAuth(http.HandlerFunc(a.saveKoboProgress)))
	a.mux.Handle("GET /api/v1/users", a.requireAuth(http.HandlerFunc(a.listUsers), "admin", false))
	a.mux.Handle("POST /api/v1/users", a.requireAuth(http.HandlerFunc(a.createUser), "admin", true))
	a.mux.Handle("PATCH /api/v1/users/{id}", a.requireAuth(http.HandlerFunc(a.updateUser), "admin", true))
	a.mux.Handle("DELETE /api/v1/users/{id}", a.requireAuth(http.HandlerFunc(a.deleteUser), "admin", true))
	a.mux.Handle("GET /api/v1/users/{id}/access", a.requireAuth(http.HandlerFunc(a.userAccessInfo), "admin", false))
	a.mux.Handle("POST /api/v1/users/{id}/password", a.requireAuth(http.HandlerFunc(a.resetUserPassword), "admin", true))
	a.mux.Handle("DELETE /api/v1/users/{id}/sessions", a.requireAuth(http.HandlerFunc(a.revokeUserSessions), "admin", true))
	a.mux.Handle("DELETE /api/v1/users/{id}/sessions/{sessionId}", a.requireAuth(http.HandlerFunc(a.revokeUserSession), "admin", true))
	a.mux.Handle("GET /api/v1/home", a.requireAuth(http.HandlerFunc(a.homeDashboard), "", false))
	a.mux.Handle("GET /api/v1/favorites", a.requireAuth(http.HandlerFunc(a.listFavorites), "", false))
	a.mux.Handle("GET /api/v1/recommendations", a.requireAuth(http.HandlerFunc(a.listRecommendations), "", false))
	a.mux.Handle("GET /api/v1/book-files", a.requireAuth(http.HandlerFunc(a.listBookFiles), "", false))
	a.mux.Handle("POST /api/v1/book-files", a.requireAuth(http.HandlerFunc(a.uploadBookFile), "admin", true))
	a.mux.Handle("GET /api/v1/book-files/{id}", a.requireAuth(http.HandlerFunc(a.bookDetail), "", false))
	a.mux.Handle("PUT /api/v1/book-files/{id}/favorite", a.requireAuth(http.HandlerFunc(a.favoriteBook), "", true))
	a.mux.Handle("DELETE /api/v1/book-files/{id}/favorite", a.requireAuth(http.HandlerFunc(a.unfavoriteBook), "", true))
	a.mux.Handle("GET /api/v1/book-files/{id}/content", a.requireAuth(http.HandlerFunc(a.bookContent), "", false))
	a.mux.Handle("GET /api/v1/book-files/{id}/cover", a.requireAuth(http.HandlerFunc(a.bookCover), "", false))
	a.mux.Handle("POST /api/v1/book-files/{id}/cover/regenerate", a.requireAuth(http.HandlerFunc(a.regeneratePDFCover), "admin", true))
	a.mux.Handle("GET /api/v1/book-files/{id}/text", a.requireAuth(http.HandlerFunc(a.bookExtractedText), "", false))
	a.mux.Handle("GET /api/v1/book-files/{id}/progress", a.requireAuth(http.HandlerFunc(a.getProgress), "", false))
	a.mux.Handle("PUT /api/v1/book-files/{id}/progress", a.requireAuth(http.HandlerFunc(a.saveProgress), "", true))
	a.mux.Handle("GET /api/v1/book-files/{id}/marks", a.requireAuth(http.HandlerFunc(a.listReadingMarks), "", false))
	a.mux.Handle("POST /api/v1/book-files/{id}/marks", a.requireAuth(http.HandlerFunc(a.createReadingMark), "", true))
	a.mux.Handle("PATCH /api/v1/reading-marks/{id}", a.requireAuth(http.HandlerFunc(a.updateReadingMark), "", true))
	a.mux.Handle("DELETE /api/v1/reading-marks/{id}", a.requireAuth(http.HandlerFunc(a.deleteReadingMark), "", true))
	a.mux.Handle("POST /api/v1/book-files/{id}/reading-sessions", a.requireAuth(http.HandlerFunc(a.startReadingSession), "", true))
	a.mux.Handle("PATCH /api/v1/reading-sessions/{id}", a.requireAuth(http.HandlerFunc(a.advanceReadingSession), "", true))
	a.mux.Handle("GET /api/v1/categories", a.requireAuth(http.HandlerFunc(a.listCategories), "", false))
	a.mux.Handle("GET /api/v1/admin/categories", a.requireAuth(http.HandlerFunc(a.listAdminCategories), "admin", false))
	a.mux.Handle("POST /api/v1/admin/categories", a.requireAuth(http.HandlerFunc(a.createCategory), "admin", true))
	a.mux.Handle("PATCH /api/v1/admin/categories/{id}", a.requireAuth(http.HandlerFunc(a.updateCategory), "admin", true))
	a.mux.Handle("GET /api/v1/admin/classification-rules", a.requireAuth(http.HandlerFunc(a.listClassificationRules), "admin", false))
	a.mux.Handle("PATCH /api/v1/admin/classification-rules/{id}", a.requireAuth(http.HandlerFunc(a.updateClassificationRule), "admin", true))
	a.mux.Handle("PATCH /api/v1/admin/metadata/batch", a.requireAuth(http.HandlerFunc(a.batchUpdateMetadata), "admin", true))
	a.mux.Handle("GET /api/v1/admin/catalog/duplicates", a.requireAuth(http.HandlerFunc(a.listDuplicateCatalogGroups), "admin", false))
	a.mux.Handle("POST /api/v1/admin/catalog/merge-works", a.requireAuth(http.HandlerFunc(a.mergeWorks), "admin", true))
	a.mux.Handle("POST /api/v1/admin/catalog/merge-editions", a.requireAuth(http.HandlerFunc(a.mergeEditions), "admin", true))
	a.mux.Handle("GET /api/v1/admin/bibliography-sources", a.requireAuth(http.HandlerFunc(a.listBibliographySources), "admin", false))
	a.mux.Handle("PATCH /api/v1/admin/bibliography-sources/{id}", a.requireAuth(http.HandlerFunc(a.updateBibliographySource), "admin", true))
	a.mux.Handle("POST /api/v1/admin/bibliography-sources/{id}/test", a.requireAuth(http.HandlerFunc(a.testBibliographySource), "admin", true))
	a.mux.Handle("GET /api/v1/review-queue", a.requireAuth(http.HandlerFunc(a.listReviewQueue), "admin", false))
	a.mux.Handle("GET /api/v1/editions/{id}/review", a.requireAuth(http.HandlerFunc(a.getEditionReview), "admin", false))
	a.mux.Handle("PUT /api/v1/editions/{id}/review", a.requireAuth(http.HandlerFunc(a.reviewEdition), "admin", true))
	a.mux.Handle("POST /api/v1/editions/{id}/ai-classify", a.requireAuth(http.HandlerFunc(a.aiClassifyEdition), "admin", true))
	a.mux.Handle("POST /api/v1/editions/{id}/bibliography-search", a.requireAuth(http.HandlerFunc(a.searchBibliography), "admin", true))
	a.mux.Handle("GET /api/v1/import-jobs", a.requireAuth(http.HandlerFunc(a.listImportJobs), "admin", false))
	a.mux.Handle("GET /api/v1/admin/import-sources", a.requireAuth(http.HandlerFunc(a.listImportSources), "admin", false))
	a.mux.Handle("GET /api/v1/background-jobs", a.requireAuth(http.HandlerFunc(a.listBackgroundJobs), "admin", false))
	a.mux.Handle("GET /api/v1/audit-events", a.requireAuth(http.HandlerFunc(a.listAuditEvents), "admin", false))
	a.mux.Handle("GET /api/v1/system/storage", a.requireAuth(http.HandlerFunc(a.storageAudit), "admin", false))
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
	clientIP := a.clientIP(r)
	username := strings.ToLower(strings.TrimSpace(input.Username))
	limitKey := clientIP + "|" + username
	if allowed, retryAfter := a.loginLimiter.allow(limitKey, time.Now()); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retryAfter.Seconds()))))
		a.recordAudit(nil, username, "auth.login.blocked", clientIP, http.StatusTooManyRequests, nil)
		writeError(w, http.StatusTooManyRequests, "login_rate_limited", "too many login attempts; try again later")
		return
	}
	user, valid, err := a.store.Authenticate(r.Context(), input.Username, input.Password)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !valid {
		blocked, retryAfter := a.loginLimiter.failure(limitKey, time.Now())
		status := http.StatusUnauthorized
		code := "invalid_credentials"
		message := "invalid username or password"
		if blocked {
			status = http.StatusTooManyRequests
			code = "login_rate_limited"
			message = "too many login attempts; try again later"
			w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retryAfter.Seconds()))))
		}
		a.recordAudit(nil, username, "auth.login.failed", clientIP, status, nil)
		writeError(w, status, code, message)
		return
	}
	a.loginLimiter.success(limitKey)
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
	if err := a.store.CreateSession(r.Context(), rawToken, csrfToken, user.ID, expiresAt, clientIP, truncateRunes(r.UserAgent(), 512)); err != nil {
		a.internalError(w, err)
		return
	}
	a.recordAudit(&user.ID, user.Username, "auth.login.succeeded", clientIP, http.StatusOK, nil)
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
	users, err := a.store.ListManagedUsers(r.Context())
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
	if !validUsername(input.Username) {
		writeError(w, http.StatusBadRequest, "invalid_username", "username must contain 1 to 64 letters, numbers, dots, underscores, or hyphens")
		return
	}
	user, err := a.store.CreateUser(r.Context(), input.Username, input.Password, input.Role)
	if err != nil {
		writeError(w, http.StatusConflict, "user_not_created", "username already exists or input is invalid")
		return
	}
	writeJSON(w, http.StatusCreated, user)
}

func (a *API) updateUser(w http.ResponseWriter, r *http.Request) {
	userID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input struct {
		Username string `json:"username"`
		Role     string `json:"role"`
		Disabled bool   `json:"disabled"`
	}
	if err := readJSON(w, r, &input, 64<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if !validUsername(input.Username) || (input.Role != "admin" && input.Role != "reader") {
		writeError(w, http.StatusBadRequest, "invalid_user", "username or role is invalid")
		return
	}
	current := sessionFromContext(r.Context()).User
	if userID == current.ID && (input.Disabled || input.Role != "admin") {
		writeError(w, http.StatusForbidden, "cannot_change_current_admin", "the current administrator cannot be disabled or demoted")
		return
	}
	user, err := a.store.UpdateManagedUser(r.Context(), userID, input.Username, input.Role, input.Disabled)
	if err != nil {
		writeUserManagementError(w, err, "user_not_updated")
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (a *API) deleteUser(w http.ResponseWriter, r *http.Request) {
	userID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	if userID == sessionFromContext(r.Context()).User.ID {
		writeError(w, http.StatusForbidden, "cannot_delete_current_user", "the current administrator cannot delete their own account")
		return
	}
	if err := a.store.DeleteManagedUser(r.Context(), userID); err != nil {
		writeUserManagementError(w, err, "user_not_deleted")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) resetUserPassword(w http.ResponseWriter, r *http.Request) {
	userID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	if err := readJSON(w, r, &input, 64<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if len(input.Password) < 12 {
		writeError(w, http.StatusBadRequest, "weak_password", "password must contain at least 12 characters")
		return
	}
	if err := a.store.ResetUserPassword(r.Context(), userID, input.Password); err != nil {
		writeUserManagementError(w, err, "password_not_reset")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) revokeUserSessions(w http.ResponseWriter, r *http.Request) {
	userID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	if err := a.store.RevokeUserSessions(r.Context(), userID); err != nil {
		writeUserManagementError(w, err, "sessions_not_revoked")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) revokeUserSession(w http.ResponseWriter, r *http.Request) {
	userID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	sessionID, ok := parseID(w, r.PathValue("sessionId"))
	if !ok {
		return
	}
	if err := a.store.RevokeUserSession(r.Context(), userID, sessionID); err != nil {
		writeUserManagementError(w, err, "session_not_revoked")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) userAccessInfo(w http.ResponseWriter, r *http.Request) {
	userID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	currentToken := ""
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		currentToken = cookie.Value
	}
	info, err := a.store.GetUserAccessInfo(r.Context(), userID, currentToken)
	if err != nil {
		writeUserManagementError(w, err, "access_info_not_loaded")
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func writeUserManagementError(w http.ResponseWriter, err error, fallbackCode string) {
	switch {
	case errors.Is(err, store.ErrUserNotFound):
		writeError(w, http.StatusNotFound, "user_not_found", "user not found")
	case errors.Is(err, store.ErrSessionNotFound):
		writeError(w, http.StatusNotFound, "session_not_found", "session not found")
	case errors.Is(err, store.ErrLastActiveAdmin):
		writeError(w, http.StatusConflict, "last_active_admin", "at least one active administrator must remain")
	default:
		writeError(w, http.StatusConflict, fallbackCode, "the user change could not be completed")
	}
}

func (a *API) listBookFiles(w http.ResponseWriter, r *http.Request) {
	query, err := parseCatalogQuery(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_catalog_query", err.Error())
		return
	}
	userSession := sessionFromContext(r.Context())
	page, err := a.store.SearchCatalogBooks(r.Context(), userSession.User.ID, query)
	if err != nil {
		a.internalError(w, err)
		return
	}
	for index := range page.Items {
		a.decorateBook(&page.Items[index])
	}
	writeJSON(w, http.StatusOK, page)
}

func (a *API) homeDashboard(w http.ResponseWriter, r *http.Request) {
	userSession := sessionFromContext(r.Context())
	dashboard, err := a.store.GetHomeDashboard(r.Context(), userSession.User.ID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	for index := range dashboard.ContinueReading {
		a.decorateBook(&dashboard.ContinueReading[index].Book)
	}
	for index := range dashboard.HotBooks {
		a.decorateBook(&dashboard.HotBooks[index].Book)
	}
	for index := range dashboard.Recommendations {
		a.decorateBook(&dashboard.Recommendations[index].Book)
	}
	for index := range dashboard.RecentlyAdded {
		a.decorateBook(&dashboard.RecentlyAdded[index])
	}
	for index := range dashboard.Categories {
		dashboard.Categories[index].CoverURLs = make([]string, 0, len(dashboard.Categories[index].CoverBookIDs))
		for _, bookFileID := range dashboard.Categories[index].CoverBookIDs {
			dashboard.Categories[index].CoverURLs = append(dashboard.Categories[index].CoverURLs, fmt.Sprintf("/api/v1/book-files/%d/cover", bookFileID))
		}
	}
	writeJSON(w, http.StatusOK, dashboard)
}

func (a *API) bookDetail(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	userSession := sessionFromContext(r.Context())
	detail, found, err := a.store.GetBookDetail(r.Context(), userSession.User.ID, id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "book_not_found", "book file not found")
		return
	}
	a.decorateBook(&detail.Book)
	writeJSON(w, http.StatusOK, detail)
}

func (a *API) listFavorites(w http.ResponseWriter, r *http.Request) {
	page, pageSize, err := parsePagination(r, store.DefaultCatalogPageSize, store.MaxCatalogPageSize)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_pagination", err.Error())
		return
	}
	userSession := sessionFromContext(r.Context())
	result, err := a.store.ListFavoriteBooks(r.Context(), userSession.User.ID, page, pageSize)
	if err != nil {
		a.internalError(w, err)
		return
	}
	for index := range result.Items {
		a.decorateBook(&result.Items[index].Book)
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *API) favoriteBook(w http.ResponseWriter, r *http.Request) {
	a.setFavorite(w, r, true)
}

func (a *API) unfavoriteBook(w http.ResponseWriter, r *http.Request) {
	a.setFavorite(w, r, false)
}

func (a *API) setFavorite(w http.ResponseWriter, r *http.Request, favorite bool) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	if _, found, err := a.store.GetCatalogBook(r.Context(), id); err != nil {
		a.internalError(w, err)
		return
	} else if !found {
		writeError(w, http.StatusNotFound, "book_not_found", "book file not found")
		return
	}
	userSession := sessionFromContext(r.Context())
	state, err := a.store.SetFavorite(r.Context(), userSession.User.ID, id, favorite)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (a *API) listRecommendations(w http.ResponseWriter, r *http.Request) {
	limit := 12
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 24 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit must be between 1 and 24")
			return
		}
		limit = parsed
	}
	userSession := sessionFromContext(r.Context())
	result, err := a.store.GetRecommendations(r.Context(), userSession.User.ID, limit)
	if err != nil {
		a.internalError(w, err)
		return
	}
	for index := range result.Items {
		a.decorateBook(&result.Items[index].Book)
	}
	writeJSON(w, http.StatusOK, result)
}

func parsePagination(r *http.Request, defaultPageSize, maxPageSize int) (int, int, error) {
	page, pageSize := 1, defaultPageSize
	if value := r.URL.Query().Get("page"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 {
			return 0, 0, fmt.Errorf("page must be a positive integer")
		}
		page = parsed
	}
	if value := r.URL.Query().Get("pageSize"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > maxPageSize {
			return 0, 0, fmt.Errorf("pageSize must be between 1 and %d", maxPageSize)
		}
		pageSize = parsed
	}
	return page, pageSize, nil
}

func parseCatalogQuery(r *http.Request) (store.CatalogQuery, error) {
	values := r.URL.Query()
	query := store.CatalogQuery{
		Query: values.Get("q"), CategorySlug: values.Get("category"), Format: values.Get("format"),
		Status: values.Get("status"), Sort: values.Get("sort"), Page: 1, PageSize: store.DefaultCatalogPageSize,
	}
	if len(query.Query) > 200 || len(query.CategorySlug) > 100 {
		return store.CatalogQuery{}, fmt.Errorf("search query is too long")
	}
	if value := values.Get("page"); value != "" {
		page, err := strconv.Atoi(value)
		if err != nil || page < 1 {
			return store.CatalogQuery{}, fmt.Errorf("page must be a positive integer")
		}
		query.Page = page
	}
	if value := values.Get("pageSize"); value != "" {
		pageSize, err := strconv.Atoi(value)
		if err != nil || pageSize < 1 || pageSize > store.MaxCatalogPageSize {
			return store.CatalogQuery{}, fmt.Errorf("pageSize must be between 1 and %d", store.MaxCatalogPageSize)
		}
		query.PageSize = pageSize
	}
	if query.Format != "" && query.Format != "pdf" && query.Format != "epub" && query.Format != "mobi" && query.Format != "azw3" {
		return store.CatalogQuery{}, fmt.Errorf("format must be pdf, epub, mobi, or azw3")
	}
	validStatuses := map[string]bool{"": true, "unread": true, "reading": true, "paused": true, "finished": true, "abandoned": true}
	if !validStatuses[query.Status] {
		return store.CatalogQuery{}, fmt.Errorf("status is invalid")
	}
	if query.Sort == "" && strings.TrimSpace(query.Query) != "" {
		query.Sort = "relevance"
	}
	validSorts := map[string]bool{"": true, "relevance": true, "title": true, "newest": true, "hot": true}
	if !validSorts[query.Sort] {
		return store.CatalogQuery{}, fmt.Errorf("sort is invalid")
	}
	return store.NormalizeCatalogQuery(query), nil
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
			writeError(w, http.StatusUnsupportedMediaType, "unsupported_format", "only valid PDF, EPUB, MOBI, and AZW3 files are supported")
		case errors.Is(err, library.ErrUploadTooLarge):
			writeError(w, http.StatusRequestEntityTooLarge, "upload_too_large", "file exceeds the configured upload limit")
		case errors.Is(err, importing.ErrMetadataExtraction):
			writeError(w, http.StatusUnprocessableEntity, "metadata_extraction_failed", "ebook metadata could not be extracted")
		case errors.Is(err, importing.ErrReadableConversion):
			writeError(w, http.StatusUnprocessableEntity, "kindle_conversion_failed", "MOBI/AZW3 could not be converted for reading; the file may be DRM-protected or damaged")
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
	if book.TextPath != "" {
		book.TextURL = fmt.Sprintf("/api/v1/book-files/%d/text", book.ID)
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
	servedFilename := book.OriginalFilename
	servedMIMEType := book.MIMEType
	if mobiconvert.IsKindleFormat(book.Format) {
		if a.converter == nil {
			writeError(w, http.StatusServiceUnavailable, "kindle_converter_unavailable", "MOBI/AZW3 reader conversion is not configured")
			return
		}
		converted, conversionErr := a.converter.EnsureEPUB(r.Context(), absolutePath, book.Format, hex.EncodeToString(book.SHA256))
		if conversionErr != nil {
			status := http.StatusUnprocessableEntity
			code := "kindle_conversion_failed"
			if errors.Is(conversionErr, mobiconvert.ErrConversionUnavailable) {
				status = http.StatusServiceUnavailable
				code = "kindle_converter_unavailable"
			}
			writeError(w, status, code, "MOBI/AZW3 reading copy could not be prepared; the file may be DRM-protected or damaged")
			return
		}
		absolutePath = converted.Path
		servedFilename = strings.TrimSuffix(book.OriginalFilename, filepath.Ext(book.OriginalFilename)) + ".epub"
		servedMIMEType = "application/epub+zip"
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
	w.Header().Set("Content-Type", servedMIMEType)
	w.Header().Set("Content-Disposition", "inline; filename*=UTF-8''"+url.PathEscape(servedFilename))
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeContent(w, r, servedFilename, info.ModTime(), file)
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
	w.Header().Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, filepath.Base(absolutePath), info.ModTime(), file)
}

func (a *API) regeneratePDFCover(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input struct {
		PageNumber int `json:"pageNumber"`
	}
	if err := readJSON(w, r, &input, 8<<10); err != nil || input.PageNumber < 1 || input.PageNumber > 100000 {
		writeError(w, http.StatusBadRequest, "invalid_cover_page", "pageNumber must be between 1 and 100000")
		return
	}
	book, found, err := a.store.GetCatalogBook(r.Context(), id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "book_not_found", "book file not found")
		return
	}
	if book.Format != "pdf" {
		writeError(w, http.StatusConflict, "cover_regeneration_unsupported", "only PDF covers can be regenerated from a selected page")
		return
	}
	if book.PageCount != nil && input.PageNumber > *book.PageCount {
		writeError(w, http.StatusBadRequest, "invalid_cover_page", fmt.Sprintf("pageNumber exceeds the PDF page count (%d)", *book.PageCount))
		return
	}
	userSession := sessionFromContext(r.Context())
	job, created, err := pdfassets.EnqueueCoverRegeneration(r.Context(), a.store, userSession.User.ID, book.ID, input.PageNumber)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"job": job, "created": created})
}

func (a *API) bookExtractedText(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	book, found, err := a.store.GetCatalogBook(r.Context(), id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found || book.TextPath == "" {
		writeError(w, http.StatusNotFound, "text_not_found", "extracted PDF text not found")
		return
	}
	absolutePath, err := a.library.ResolveExtractedText(book.TextPath)
	if err != nil {
		a.internalError(w, err)
		return
	}
	file, err := os.Open(absolutePath)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusGone, "text_missing", "cached PDF text is missing")
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
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", "inline; filename*=UTF-8''"+url.PathEscape(book.Title+".txt"))
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

func (a *API) listAdminCategories(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListAllCategories(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) listClassificationRules(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListClassificationRules(r.Context(), false)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) updateClassificationRule(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input struct {
		Keywords []string `json:"keywords"`
		Enabled  bool     `json:"enabled"`
		Priority int      `json:"priority"`
	}
	if err := readJSON(w, r, &input, 32<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_classification_rule", err.Error())
		return
	}
	for _, keyword := range input.Keywords {
		if utf8.RuneCountInString(strings.TrimSpace(keyword)) > 100 {
			writeError(w, http.StatusBadRequest, "invalid_classification_rule", "each keyword must contain at most 100 characters")
			return
		}
	}
	item, found, err := a.store.UpdateClassificationRule(r.Context(), id, input.Keywords, input.Enabled, input.Priority)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_classification_rule", err.Error())
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "classification_rule_not_found", "classification rule not found")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) batchUpdateMetadata(w http.ResponseWriter, r *http.Request) {
	var input struct {
		EditionIDs    []int64  `json:"editionIds"`
		Language      *string  `json:"language"`
		Publisher     *string  `json:"publisher"`
		PublishedYear *int     `json:"publishedYear"`
		CategorySlugs []string `json:"categorySlugs"`
		CategoryMode  string   `json:"categoryMode"`
	}
	if err := readJSON(w, r, &input, 64<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_batch_metadata", err.Error())
		return
	}
	if input.Language != nil && utf8.RuneCountInString(*input.Language) > 35 || input.Publisher != nil && utf8.RuneCountInString(*input.Publisher) > 300 {
		writeError(w, http.StatusBadRequest, "invalid_batch_metadata", "language or publisher is too long")
		return
	}
	updated, err := a.store.BatchUpdateMetadata(r.Context(), sessionFromContext(r.Context()).User.ID, input.EditionIDs, store.BatchMetadataPatch{
		Language: input.Language, Publisher: input.Publisher, PublishedYear: input.PublishedYear,
		CategorySlugs: input.CategorySlugs, CategoryMode: strings.TrimSpace(input.CategoryMode),
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_batch_metadata", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": updated})
}

func (a *API) listDuplicateCatalogGroups(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListDuplicateCatalogGroups(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) mergeWorks(w http.ResponseWriter, r *http.Request) {
	a.mergeCatalogEntity(w, r, "work")
}

func (a *API) mergeEditions(w http.ResponseWriter, r *http.Request) {
	a.mergeCatalogEntity(w, r, "edition")
}

func (a *API) mergeCatalogEntity(w http.ResponseWriter, r *http.Request, kind string) {
	var input struct {
		SourceID int64 `json:"sourceId"`
		TargetID int64 `json:"targetId"`
	}
	if err := readJSON(w, r, &input, 8<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_catalog_merge", err.Error())
		return
	}
	var err error
	if kind == "work" {
		err = a.store.MergeWorks(r.Context(), input.SourceID, input.TargetID)
	} else {
		err = a.store.MergeEditions(r.Context(), input.SourceID, input.TargetID)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "catalog_merge_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"merged": true, "sourceId": input.SourceID, "targetId": input.TargetID})
}

func (a *API) createCategory(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Slug     string `json:"slug"`
		Name     string `json:"name"`
		ParentID *int64 `json:"parentId"`
	}
	if err := readJSON(w, r, &input, 32<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	input.Slug = strings.ToLower(strings.TrimSpace(input.Slug))
	input.Name = strings.TrimSpace(input.Name)
	if !categorySlugPattern.MatchString(input.Slug) || len(input.Slug) > 80 || input.Name == "" || len([]rune(input.Name)) > 60 || (input.ParentID != nil && *input.ParentID <= 0) {
		writeError(w, http.StatusBadRequest, "invalid_category", "category slug, name, or parent is invalid")
		return
	}
	item, err := a.store.CreateCategory(r.Context(), input.Slug, input.Name, input.ParentID)
	if err != nil {
		writeError(w, http.StatusConflict, "category_not_created", "slug already exists or parent is invalid")
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *API) updateCategory(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input struct {
		Name     string `json:"name"`
		ParentID *int64 `json:"parentId"`
		Active   *bool  `json:"active"`
	}
	if err := readJSON(w, r, &input, 32<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len([]rune(input.Name)) > 60 || input.Active == nil || (input.ParentID != nil && *input.ParentID <= 0) {
		writeError(w, http.StatusBadRequest, "invalid_category", "category name, parent, or active state is invalid")
		return
	}
	item, err := a.store.UpdateCategory(r.Context(), id, input.Name, input.ParentID, *input.Active)
	if err != nil {
		writeError(w, http.StatusConflict, "category_not_updated", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) listBibliographySources(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListBibliographySources(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) updateBibliographySource(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input store.BibliographySourceUpdate
	if err := readJSON(w, r, &input, 32<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	input.BaseURL = strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")
	if err := validateBibliographySourceUpdate(input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_bibliography_source", err.Error())
		return
	}
	item, found, err := a.store.UpdateBibliographySource(r.Context(), id, input)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "bibliography_source_not_found", "bibliography source not found")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func validateBibliographySourceUpdate(input store.BibliographySourceUpdate) error {
	if input.Priority < 1 || input.Priority > 1000 {
		return errors.New("priority must be between 1 and 1000")
	}
	if input.TimeoutMS < 1000 || input.TimeoutMS > 60000 {
		return errors.New("timeoutMs must be between 1000 and 60000")
	}
	if input.MaxResults < 1 || input.MaxResults > 20 {
		return errors.New("maxResults must be between 1 and 20")
	}
	if input.Enabled && input.BaseURL == "" {
		return errors.New("baseUrl is required when the source is enabled")
	}
	if input.BaseURL == "" {
		return nil
	}
	if len(input.BaseURL) > 2048 {
		return errors.New("baseUrl is too long")
	}
	parsed, err := url.Parse(input.BaseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return errors.New("baseUrl must be an absolute HTTP(S) URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("baseUrl cannot contain credentials, a query, or a fragment")
	}
	return nil
}

func (a *API) testBibliographySource(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	source, found, err := a.store.GetBibliographySource(r.Context(), id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "bibliography_source_not_found", "bibliography source not found")
		return
	}
	if strings.TrimSpace(source.BaseURL) == "" {
		writeError(w, http.StatusBadRequest, "bibliography_source_not_configured", "save a service URL before testing")
		return
	}
	result := a.bibliography.TestSource(r.Context(), bibliographySourceConfig(source))
	updated, _, loadErr := a.store.GetBibliographySource(r.Context(), id)
	if loadErr != nil {
		a.internalError(w, loadErr)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": result, "source": updated})
}

func bibliographySourceConfig(source store.BibliographySource) bibliography.SourceConfig {
	return bibliography.SourceConfig{
		ID: source.ID, Provider: source.Provider, BaseURL: source.BaseURL, Priority: source.Priority,
		Timeout: time.Duration(source.TimeoutMS) * time.Millisecond, MaxResults: source.MaxResults,
	}
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
	if errors.Is(err, bibliography.ErrNoProviders) {
		writeError(w, http.StatusConflict, "bibliography_not_configured", "no external bibliography source is enabled")
		return
	}
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

func (a *API) listImportSources(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": a.importSources})
}

func (a *API) listBackgroundJobs(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListBackgroundJobs(r.Context(), 100)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) listAuditEvents(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListAuditEvents(r.Context(), 100)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) storageAudit(w http.ResponseWriter, r *http.Request) {
	records, err := a.store.ListStorageRecords(r.Context())
	if err != nil {
		a.internalError(w, err)
		return
	}
	expected := make([]library.ExpectedFile, 0, len(records))
	for _, record := range records {
		expected = append(expected, library.ExpectedFile{
			BookFileID: record.BookFileID, Path: record.Path, SizeBytes: record.SizeBytes, SHA256: record.SHA256,
		})
	}
	report, err := a.library.Audit(expected, r.URL.Query().Get("deep") == "true")
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
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

type readingMarkInput struct {
	Kind            string          `json:"kind"`
	Position        json.RawMessage `json:"position"`
	OverallProgress float64         `json:"overallProgress"`
	Label           string          `json:"label"`
	Body            string          `json:"body"`
}

func normalizeReadingMarkText(kind, label, body string) (string, string, bool) {
	label = strings.TrimSpace(label)
	body = strings.TrimSpace(body)
	if (kind != "bookmark" && kind != "note") || utf8.RuneCountInString(label) < 1 || utf8.RuneCountInString(label) > 200 || utf8.RuneCountInString(body) > 10000 {
		return "", "", false
	}
	if kind == "note" && body == "" {
		return "", "", false
	}
	if kind == "bookmark" {
		body = ""
	}
	return label, body, true
}

func (a *API) listReadingMarks(w http.ResponseWriter, r *http.Request) {
	bookID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	if _, found, err := a.store.GetBookFile(r.Context(), bookID); err != nil {
		a.internalError(w, err)
		return
	} else if !found {
		writeError(w, http.StatusNotFound, "book_not_found", "book file not found")
		return
	}
	userID := sessionFromContext(r.Context()).User.ID
	marks, err := a.store.ListReadingMarks(r.Context(), userID, bookID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": marks})
}

func (a *API) createReadingMark(w http.ResponseWriter, r *http.Request) {
	bookID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input readingMarkInput
	if err := readJSON(w, r, &input, 24<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_reading_mark", err.Error())
		return
	}
	label, body, validText := normalizeReadingMarkText(input.Kind, input.Label, input.Body)
	if !validPosition(input.Position) || input.OverallProgress < 0 || input.OverallProgress > 1 || !validText {
		writeError(w, http.StatusBadRequest, "invalid_reading_mark", "kind, position, progress, label or note body is invalid")
		return
	}
	if _, found, err := a.store.GetBookFile(r.Context(), bookID); err != nil {
		a.internalError(w, err)
		return
	} else if !found {
		writeError(w, http.StatusNotFound, "book_not_found", "book file not found")
		return
	}
	userID := sessionFromContext(r.Context()).User.ID
	mark, err := a.store.SaveReadingMark(r.Context(), userID, bookID, input.Kind, input.Position, input.OverallProgress, label, body)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, mark)
}

func (a *API) updateReadingMark(w http.ResponseWriter, r *http.Request) {
	markID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input struct {
		Label string `json:"label"`
		Body  string `json:"body"`
	}
	if err := readJSON(w, r, &input, 16<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_reading_mark", err.Error())
		return
	}
	userID := sessionFromContext(r.Context()).User.ID
	existing, found, err := a.store.GetReadingMark(r.Context(), userID, markID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "reading_mark_not_found", "reading mark not found")
		return
	}
	label, body, valid := normalizeReadingMarkText(existing.Kind, input.Label, input.Body)
	if !valid {
		writeError(w, http.StatusBadRequest, "invalid_reading_mark", "label or note body is invalid")
		return
	}
	mark, found, err := a.store.UpdateReadingMark(r.Context(), userID, markID, label, body)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "reading_mark_not_found", "reading mark not found")
		return
	}
	writeJSON(w, http.StatusOK, mark)
}

func (a *API) deleteReadingMark(w http.ResponseWriter, r *http.Request) {
	markID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	userID := sessionFromContext(r.Context()).User.ID
	deleted, err := a.store.DeleteReadingMark(r.Context(), userID, markID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "reading_mark_not_found", "reading mark not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
		authenticatedRequest := r.WithContext(context.WithValue(r.Context(), sessionContextKey, session))
		if !csrfRequired || requiredRole != "admin" {
			next.ServeHTTP(w, authenticatedRequest)
			return
		}
		recorder := &auditResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(recorder, authenticatedRequest)
		a.recordAudit(&session.User.ID, session.User.Username, r.Method+" "+r.Pattern, a.clientIP(r), recorder.statusCode, map[string]any{"path": r.URL.Path})
	})
}

type auditResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (w *auditResponseWriter) WriteHeader(statusCode int) {
	w.statusCode = statusCode
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *auditResponseWriter) Write(content []byte) (int, error) {
	return w.ResponseWriter.Write(content)
}

func (a *API) recordAudit(actorID *int64, actorName, action, clientIP string, statusCode int, details map[string]any) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := a.store.RecordAuditEvent(ctx, actorID, actorName, action, clientIP, statusCode, details); err != nil {
		a.logger.Warn("audit event write failed", "action", action, "error", err)
	}
}

func (a *API) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err != nil {
		host = strings.TrimSpace(r.RemoteAddr)
	}
	remoteIP := net.ParseIP(host)
	if a.trustedProxy != nil && remoteIP != nil && a.trustedProxy.Contains(remoteIP) {
		for _, value := range strings.Split(r.Header.Get("X-Forwarded-For"), ",") {
			if forwarded := net.ParseIP(strings.TrimSpace(value)); forwarded != nil {
				return forwarded.String()
			}
		}
	}
	if remoteIP != nil {
		return remoteIP.String()
	}
	return host
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

func validUsername(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > 64 {
		return false
	}
	for index, char := range []rune(value) {
		if unicode.IsLetter(char) || unicode.IsDigit(char) || (index > 0 && (char == '.' || char == '_' || char == '-')) {
			continue
		}
		return false
	}
	return true
}

func truncateRunes(value string, maxRunes int) string {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) <= maxRunes {
		return value
	}
	return string([]rune(value)[:maxRunes])
}
