package httpapi

import (
	"net/http"
)

func (a *API) requireBookAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bookID, ok := parseID(w, r.PathValue("id"))
		if !ok {
			return
		}
		if !a.ensureBookAccess(w, r, bookID) {
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) ensureBookAccess(w http.ResponseWriter, r *http.Request, bookID int64) bool {
	allowed, found, err := a.store.CanAccessBook(r.Context(), sessionFromContext(r.Context()).User.ID, bookID)
	if err != nil {
		a.internalError(w, err)
		return false
	}
	if !found || !allowed {
		writeError(w, http.StatusNotFound, "book_not_found", "book file not found")
		return false
	}
	return true
}

func (a *API) listUserBookPermissions(w http.ResponseWriter, r *http.Request) {
	userID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	if _, found, err := a.store.GetManagedUser(r.Context(), userID); err != nil {
		a.internalError(w, err)
		return
	} else if !found {
		writeError(w, http.StatusNotFound, "user_not_found", "user not found")
		return
	}
	items, err := a.store.ListBookPermissions(r.Context(), userID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "defaultCanRead": true})
}

func (a *API) setUserBookPermission(w http.ResponseWriter, r *http.Request) {
	userID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	bookID, ok := parseID(w, r.PathValue("bookId"))
	if !ok {
		return
	}
	var input struct {
		CanRead *bool `json:"canRead"`
	}
	if err := readJSON(w, r, &input, 4<<10); err != nil || input.CanRead == nil {
		writeError(w, http.StatusBadRequest, "invalid_permission", "canRead is required")
		return
	}
	if _, found, err := a.store.GetManagedUser(r.Context(), userID); err != nil || !found {
		if err != nil {
			a.internalError(w, err)
		} else {
			writeError(w, http.StatusNotFound, "user_not_found", "user not found")
		}
		return
	}
	if _, found, err := a.store.GetBookFile(r.Context(), bookID); err != nil || !found {
		if err != nil {
			a.internalError(w, err)
		} else {
			writeError(w, http.StatusNotFound, "book_not_found", "book file not found")
		}
		return
	}
	item, err := a.store.SetBookPermission(r.Context(), userID, bookID, *input.CanRead)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) deleteUserBookPermission(w http.ResponseWriter, r *http.Request) {
	userID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	bookID, ok := parseID(w, r.PathValue("bookId"))
	if !ok {
		return
	}
	deleted, err := a.store.DeleteBookPermission(r.Context(), userID, bookID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "permission_not_found", "explicit book permission not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
