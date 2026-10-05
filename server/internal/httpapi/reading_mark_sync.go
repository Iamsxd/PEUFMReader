package httpapi

import (
	"errors"
	"github.com/google/uuid"
	"math"
	"net/http"
	"peufmreader/internal/store"
)

func (a *API) syncReadingMark(w http.ResponseWriter, r *http.Request) {
	var input store.ReadingMarkMutation
	if err := readJSON(w, r, &input, 96<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_reading_mark", "invalid mutation")
		return
	}
	if _, err := uuid.Parse(input.OperationID); err != nil || input.BookFileID <= 0 || (input.Action != "create" && input.Action != "update" && input.Action != "delete") {
		writeError(w, http.StatusBadRequest, "invalid_reading_mark", "invalid operation ID, book or action")
		return
	}
	if !a.ensureBookAccess(w, r, input.BookFileID) {
		return
	}
	userID := sessionFromContext(r.Context()).User.ID
	// A cookie can change after the client's identity check in another tab.
	// Never replay one account's offline notes into a different account.
	if input.AccountID != userID {
		writeError(w, 401, "account_changed", "账号已变化，请重新登录后同步。")
		return
	}
	if input.Action != "create" && (input.MarkID <= 0 || input.ExpectedUpdatedAt == nil) {
		writeError(w, http.StatusBadRequest, "invalid_reading_mark", "existing marks require ID and expected version")
		return
	}
	// Validate immutable type and quote from the server, not untrusted clients.
	if input.Action == "update" {
		existing, found, err := a.store.GetReadingMark(r.Context(), userID, input.MarkID)
		if err != nil {
			a.internalError(w, err)
			return
		}
		if found {
			if existing.BookFileID != input.BookFileID {
				writeError(w, 404, "reading_mark_not_found", "reading mark not found")
				return
			}
			if input.Mark.Kind != existing.Kind || input.Mark.Quote != existing.Quote {
				writeError(w, 400, "invalid_reading_mark", "kind and quote cannot be changed")
				return
			}
		}
	}
	if input.Action != "delete" {
		m := &input.Mark
		label, body, quote, color, valid := normalizeReadingMarkText(m.Kind, m.Label, m.Body, m.Quote, m.Color)
		if !valid || (input.Action == "create" && (!validPosition(m.Position) || math.IsNaN(m.OverallProgress) || m.OverallProgress < 0 || m.OverallProgress > 1)) {
			writeError(w, 400, "invalid_reading_mark", "invalid reading mark fields")
			return
		}
		m.Label, m.Body, m.Quote, m.Color = label, body, quote, color
	}
	result, err := a.store.SyncReadingMark(r.Context(), userID, input)
	switch {
	case errors.Is(err, store.ErrReadingMarkConflict):
		writeError(w, 409, "reading_mark_conflict", "此批注已在另一台设备修改。已保留本地草稿，请核对后重新保存。")
	case errors.Is(err, store.ErrReadingMarkOperationReuse):
		writeError(w, 409, "operation_reused", "operation ID reused")
	case errors.Is(err, store.ErrReadingMarkMissing):
		writeError(w, 404, "reading_mark_not_found", "reading mark not found")
	case err != nil:
		a.internalError(w, err)
	default:
		writeJSON(w, 200, result)
	}
}
