package httpapi

import (
	"context"
	"encoding/xml"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"peufmreader/internal/store"
)

type deviceTokenResponse struct {
	store.DeviceToken
	Token string `json:"token,omitempty"`
}

func (a *API) listDeviceTokens(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListDeviceTokens(r.Context(), sessionFromContext(r.Context()).User.ID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) createDeviceToken(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name        string `json:"name"`
		ExpiresDays int    `json:"expiresDays"`
	}
	if err := readJSON(w, r, &input, 8<<10); err != nil || strings.TrimSpace(input.Name) == "" || len([]rune(input.Name)) > 100 || input.ExpiresDays < 0 || input.ExpiresDays > 3650 {
		writeError(w, http.StatusBadRequest, "invalid_device_token", "name is required and expiresDays must be between 0 and 3650")
		return
	}
	rawToken, err := randomToken(32)
	if err != nil {
		a.internalError(w, err)
		return
	}
	var expiresAt *time.Time
	if input.ExpiresDays > 0 {
		value := time.Now().UTC().Add(time.Duration(input.ExpiresDays) * 24 * time.Hour)
		expiresAt = &value
	}
	item, err := a.store.CreateDeviceToken(r.Context(), sessionFromContext(r.Context()).User.ID, input.Name, rawToken, expiresAt)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, deviceTokenResponse{DeviceToken: item, Token: rawToken})
}

func (a *API) revokeDeviceToken(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	revoked, err := a.store.RevokeDeviceToken(r.Context(), sessionFromContext(r.Context()).User.ID, id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !revoked {
		writeError(w, http.StatusNotFound, "device_token_not_found", "device token not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) requireDeviceAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, rawToken := deviceCredentials(r)
		if rawToken == "" {
			w.Header().Set("WWW-Authenticate", `Basic realm="PEUFMReader OPDS"`)
			writeError(w, http.StatusUnauthorized, "device_authentication_required", "a device token is required")
			return
		}
		auth, found, err := a.store.AuthenticateDeviceToken(r.Context(), rawToken, username)
		if err != nil {
			a.internalError(w, err)
			return
		}
		if !found {
			w.Header().Set("WWW-Authenticate", `Basic realm="PEUFMReader OPDS"`)
			writeError(w, http.StatusUnauthorized, "invalid_device_token", "device token is invalid or expired")
			return
		}
		session := store.Session{User: auth.User}
		next.ServeHTTP(w, r.WithContext(withSession(r.Context(), session)))
	})
}

func deviceCredentials(r *http.Request) (string, string) {
	username, token := r.Header.Get("X-Auth-User"), r.Header.Get("X-Auth-Key")
	if token != "" {
		return username, token
	}
	if basicUser, basicPassword, ok := r.BasicAuth(); ok {
		return basicUser, basicPassword
	}
	const bearer = "Bearer "
	authorization := r.Header.Get("Authorization")
	if strings.HasPrefix(authorization, bearer) {
		return "", strings.TrimSpace(strings.TrimPrefix(authorization, bearer))
	}
	return "", ""
}

func withSession(ctx context.Context, session store.Session) context.Context {
	return context.WithValue(ctx, sessionContextKey, session)
}

type opdsLink struct {
	Rel  string `xml:"rel,attr"`
	Href string `xml:"href,attr"`
	Type string `xml:"type,attr,omitempty"`
}

type opdsAuthor struct {
	Name string `xml:"name"`
}

type opdsCategory struct {
	Term  string `xml:"term,attr"`
	Label string `xml:"label,attr"`
}

type opdsEntry struct {
	ID         string         `xml:"id"`
	Title      string         `xml:"title"`
	Updated    string         `xml:"updated"`
	Authors    []opdsAuthor   `xml:"author"`
	Categories []opdsCategory `xml:"category"`
	Links      []opdsLink     `xml:"link"`
}

type opdsFeed struct {
	XMLName   xml.Name    `xml:"feed"`
	XMLNS     string      `xml:"xmlns,attr"`
	XMLNSOPDS string      `xml:"xmlns:opds,attr"`
	ID        string      `xml:"id"`
	Title     string      `xml:"title"`
	Updated   string      `xml:"updated"`
	Links     []opdsLink  `xml:"link"`
	Entries   []opdsEntry `xml:"entry"`
}

func (a *API) opdsCatalog(w http.ResponseWriter, r *http.Request) {
	page := 1
	if raw := r.URL.Query().Get("page"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			writeError(w, http.StatusBadRequest, "invalid_page", "page must be a positive integer")
			return
		}
		page = parsed
	}
	query := store.CatalogQuery{Query: r.URL.Query().Get("q"), Page: page, PageSize: 50, Sort: "title"}
	result, err := a.store.SearchCatalogBooks(r.Context(), sessionFromContext(r.Context()).User.ID, query)
	if err != nil {
		a.internalError(w, err)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	feed := opdsFeed{XMLNS: "http://www.w3.org/2005/Atom", XMLNSOPDS: "http://opds-spec.org/2010/catalog", ID: "urn:peufmreader:catalog", Title: "PEUFMReader 书库", Updated: now,
		Links: []opdsLink{{Rel: "self", Href: fmt.Sprintf("/opds/v1.2/catalog?page=%d", page), Type: "application/atom+xml;profile=opds-catalog;kind=acquisition"}}}
	if page < result.TotalPages {
		feed.Links = append(feed.Links, opdsLink{Rel: "next", Href: fmt.Sprintf("/opds/v1.2/catalog?page=%d", page+1), Type: "application/atom+xml;profile=opds-catalog;kind=acquisition"})
	}
	for _, book := range result.Items {
		mimeType := book.MIMEType
		if book.Format == "mobi" || book.Format == "azw3" {
			mimeType = "application/epub+zip"
		}
		entry := opdsEntry{ID: fmt.Sprintf("urn:peufmreader:book:%d", book.ID), Title: book.Title, Updated: book.CreatedAt.UTC().Format(time.RFC3339),
			Links: []opdsLink{{Rel: "http://opds-spec.org/acquisition", Href: fmt.Sprintf("/opds/books/%d/download", book.ID), Type: mimeType}}}
		for _, author := range book.Authors {
			entry.Authors = append(entry.Authors, opdsAuthor{Name: author})
		}
		for _, category := range book.Categories {
			entry.Categories = append(entry.Categories, opdsCategory{Term: category.Slug, Label: category.Name})
		}
		if book.CoverPath != "" {
			entry.Links = append(entry.Links, opdsLink{Rel: "http://opds-spec.org/image", Href: fmt.Sprintf("/opds/books/%d/cover", book.ID), Type: "image/jpeg"})
		}
		feed.Entries = append(feed.Entries, entry)
	}
	w.Header().Set("Content-Type", "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(xml.Header))
	_ = xml.NewEncoder(w).Encode(feed)
}

func (a *API) koReaderAuth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"username": sessionFromContext(r.Context()).User.Username})
}

func (a *API) saveKOReaderProgress(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Document   string  `json:"document"`
		Progress   string  `json:"progress"`
		Percentage float64 `json:"percentage"`
		Device     string  `json:"device"`
		DeviceID   string  `json:"device_id"`
		BookFileID *int64  `json:"bookFileId"`
	}
	if err := readJSON(w, r, &input, 16<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_progress", err.Error())
		return
	}
	progress, err := a.store.SaveDeviceProgress(r.Context(), sessionFromContext(r.Context()).User.ID, store.DeviceProgress{
		Provider: "koreader", DocumentKey: input.Document, BookFileID: input.BookFileID, Locator: input.Progress,
		Percentage: input.Percentage, Device: input.Device, DeviceID: input.DeviceID,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_progress", err.Error())
		return
	}
	writeKOReaderProgress(w, progress)
}

func (a *API) getKOReaderProgress(w http.ResponseWriter, r *http.Request) {
	progress, found, err := a.store.GetDeviceProgress(r.Context(), sessionFromContext(r.Context()).User.ID, "koreader", r.PathValue("document"))
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "progress_not_found", "progress not found")
		return
	}
	writeKOReaderProgress(w, progress)
}

func writeKOReaderProgress(w http.ResponseWriter, progress store.DeviceProgress) {
	writeJSON(w, http.StatusOK, map[string]any{
		"document": progress.DocumentKey, "progress": progress.Locator, "percentage": progress.Percentage,
		"device": progress.Device, "device_id": progress.DeviceID, "timestamp": progress.UpdatedAt.Unix(), "bookFileId": progress.BookFileID,
	})
}

func (a *API) getKoboProgress(w http.ResponseWriter, r *http.Request) {
	bookID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	state, err := a.store.GetReadingState(r.Context(), sessionFromContext(r.Context()).User.ID, bookID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (a *API) saveKoboProgress(w http.ResponseWriter, r *http.Request) {
	bookID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input struct {
		Locator    string  `json:"locator"`
		Percentage float64 `json:"percentage"`
		Device     string  `json:"device"`
		DeviceID   string  `json:"deviceId"`
	}
	if err := readJSON(w, r, &input, 16<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_progress", err.Error())
		return
	}
	progress, err := a.store.SaveDeviceProgress(r.Context(), sessionFromContext(r.Context()).User.ID, store.DeviceProgress{
		Provider: "kobo", DocumentKey: fmt.Sprintf("peufm:%d", bookID), BookFileID: &bookID,
		Locator: input.Locator, Percentage: input.Percentage, Device: input.Device, DeviceID: input.DeviceID,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_progress", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, progress)
}
