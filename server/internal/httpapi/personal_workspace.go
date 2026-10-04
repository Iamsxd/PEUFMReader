package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
	"peufmreader/internal/store"
)

const maxPersonalShelfBatchSize = 100

func normalizePersonalShelfBookIDs(ids []int64) ([]int64, bool) {
	if len(ids) == 0 || len(ids) > maxPersonalShelfBatchSize {
		return nil, false
	}
	result := make([]int64, 0, len(ids))
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id <= 0 {
			return nil, false
		}
		if !seen[id] {
			seen[id] = true
			result = append(result, id)
		}
	}
	return result, true
}

func (a *API) personalShelfMemberships(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	values := r.URL.Query()["ids"]
	if len(values) != 1 {
		writeError(w, 400, "invalid_shelf_book_ids", "ids must contain 1–100 positive integers separated by commas")
		return
	}
	parts := strings.Split(values[0], ",")
	if len(parts) > maxPersonalShelfBatchSize {
		writeError(w, 400, "invalid_shelf_book_ids", "ids must contain 1–100 positive integers separated by commas")
		return
	}
	bookIDs := make([]int64, len(parts))
	for index, part := range parts {
		value, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
		if err != nil {
			writeError(w, 400, "invalid_shelf_book_ids", "ids must contain 1–100 positive integers separated by commas")
			return
		}
		bookIDs[index] = value
	}
	bookIDs, ok = normalizePersonalShelfBookIDs(bookIDs)
	if !ok {
		writeError(w, 400, "invalid_shelf_book_ids", "ids must contain 1–100 positive integers separated by commas")
		return
	}
	items, found, err := a.store.PersonalShelfMemberships(r.Context(), sessionFromContext(r.Context()).User.ID, id, bookIDs)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, 404, "shelf_not_found", "书架不存在。")
		return
	}
	writeJSON(w, 200, map[string]any{"bookIds": items})
}

func (a *API) addPersonalShelfBooks(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input struct {
		BookIDs []int64 `json:"bookIds"`
	}
	if err := readJSON(w, r, &input, 4<<10); err != nil {
		writeError(w, 400, "invalid_shelf_book_ids", err.Error())
		return
	}
	bookIDs, ok := normalizePersonalShelfBookIDs(input.BookIDs)
	if !ok {
		writeError(w, 400, "invalid_shelf_book_ids", "bookIds must contain 1–100 positive integers")
		return
	}
	result, found, err := a.store.AddPersonalShelfBooks(r.Context(), sessionFromContext(r.Context()).User.ID, id, bookIDs)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, 404, "shelf_book_not_found", "书架或书籍不存在。")
		return
	}
	writeJSON(w, 200, result)
}

func (a *API) searchNotebook(w http.ResponseWriter, r *http.Request) {
	page, size, err := parsePagination(r, 24, 100)
	if err != nil {
		writeError(w, 400, "invalid_pagination", err.Error())
		return
	}
	values := r.URL.Query()
	query := store.NotebookQuery{Query: strings.TrimSpace(values.Get("q")), Kind: values.Get("kind"), Color: values.Get("color"), Page: page, PageSize: size}
	if utf8.RuneCountInString(query.Query) > 200 || (query.Kind != "" && query.Kind != "note" && query.Kind != "highlight" && query.Kind != "bookmark") || (query.Color != "" && !validHighlightColor(query.Color)) {
		writeError(w, 400, "invalid_notebook_query", "invalid query, kind or color")
		return
	}
	if value := values.Get("bookId"); value != "" {
		var ok bool
		query.BookFileID, ok = parseID(w, value)
		if !ok {
			return
		}
	}
	result, err := a.store.SearchNotebook(r.Context(), sessionFromContext(r.Context()).User.ID, query)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (a *API) listPersonalShelves(w http.ResponseWriter, r *http.Request) {
	var bookID int64
	if value := r.URL.Query().Get("bookId"); value != "" {
		var ok bool
		bookID, ok = parseID(w, value)
		if !ok {
			return
		}
	}
	items, err := a.store.ListPersonalShelves(r.Context(), sessionFromContext(r.Context()).User.ID, bookID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (a *API) savePersonalShelf(w http.ResponseWriter, r *http.Request) {
	var id int64
	if r.Method == http.MethodPatch {
		var ok bool
		id, ok = parseID(w, r.PathValue("id"))
		if !ok {
			return
		}
	}
	var input struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := readJSON(w, r, &input, 4<<10); err != nil {
		writeError(w, 400, "invalid_shelf", err.Error())
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if utf8.RuneCountInString(input.Name) < 1 || utf8.RuneCountInString(input.Name) > 80 || utf8.RuneCountInString(input.Description) > 500 {
		writeError(w, 400, "invalid_shelf", "书架名称为 1–80 字，说明最多 500 字。")
		return
	}
	shelf, found, err := a.store.SavePersonalShelf(r.Context(), sessionFromContext(r.Context()).User.ID, id, input.Name, input.Description)
	if err != nil {
		var databaseErr *pgconn.PgError
		if errors.As(err, &databaseErr) && databaseErr.Code == "23505" {
			writeError(w, 409, "shelf_name_exists", "你已经有同名书架，请换一个名称。")
			return
		}
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, 404, "shelf_not_found", "书架不存在。")
		return
	}
	status := 200
	if id == 0 {
		status = 201
	}
	writeJSON(w, status, shelf)
}

func (a *API) deletePersonalShelf(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	found, err := a.store.DeletePersonalShelf(r.Context(), sessionFromContext(r.Context()).User.ID, id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, 404, "shelf_not_found", "书架不存在。")
		return
	}
	w.WriteHeader(204)
}

func (a *API) personalShelfBooks(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	userID := sessionFromContext(r.Context()).User.ID
	found, err := a.store.PersonalShelfExists(r.Context(), userID, id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, 404, "shelf_not_found", "书架不存在。")
		return
	}
	page, size, err := parsePagination(r, 24, 100)
	if err != nil {
		writeError(w, 400, "invalid_pagination", err.Error())
		return
	}
	result, err := a.store.PersonalShelfBooks(r.Context(), userID, id, page, size)
	if err != nil {
		a.internalError(w, err)
		return
	}
	for index := range result.Items {
		a.decorateBook(&result.Items[index])
	}
	writeJSON(w, 200, result)
}

func (a *API) changePersonalShelfBook(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	bookID, ok := parseID(w, r.PathValue("bookID"))
	if !ok {
		return
	}
	// Check ownership before access so another user's shelf never becomes an oracle.
	userID := sessionFromContext(r.Context()).User.ID
	found, err := a.store.PersonalShelfExists(r.Context(), userID, id)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, 404, "shelf_not_found", "书架不存在。")
		return
	}
	action := "add"
	if r.Method == http.MethodDelete {
		action = "remove"
	} else if !a.ensureBookAccess(w, r, bookID) {
		return
	}
	if r.Method == http.MethodPatch {
		var input struct {
			Direction string `json:"direction"`
		}
		if err := readJSON(w, r, &input, 1<<10); err != nil || (input.Direction != "earlier" && input.Direction != "later") {
			writeError(w, 400, "invalid_shelf_move", "direction must be earlier or later")
			return
		}
		action = input.Direction
	}
	found, err = a.store.ChangePersonalShelfBook(r.Context(), userID, id, bookID, action)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, 404, "shelf_book_not_found", "书架或书籍不存在。")
		return
	}
	w.WriteHeader(204)
}
