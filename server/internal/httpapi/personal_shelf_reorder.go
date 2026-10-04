package httpapi

import "net/http"

type personalShelfOrderInput struct {
	BookID       int64  `json:"bookId"`
	TargetBookID int64  `json:"targetBookId"`
	Placement    string `json:"placement"`
}

func validPersonalShelfOrder(input personalShelfOrderInput) bool {
	return input.BookID > 0 && input.TargetBookID > 0 && input.BookID != input.TargetBookID && (input.Placement == "before" || input.Placement == "after")
}

func (a *API) reorderPersonalShelfBook(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}
	var input personalShelfOrderInput
	if err := readJSON(w, r, &input, 1<<10); err != nil {
		writeError(w, 400, "invalid_shelf_order", err.Error())
		return
	}
	if !validPersonalShelfOrder(input) {
		writeError(w, 400, "invalid_shelf_order", "bookId and targetBookId must be distinct positive integers; placement must be before or after")
		return
	}
	found, err := a.store.ReorderPersonalShelfBook(r.Context(), sessionFromContext(r.Context()).User.ID, id, input.BookID, input.TargetBookID, input.Placement)
	if err != nil {
		a.internalError(w, err)
		return
	}
	if !found {
		writeError(w, 404, "shelf_book_not_found", "书架或书籍不存在。")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
