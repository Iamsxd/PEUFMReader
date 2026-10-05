package httpapi

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"peufmreader/internal/textindex"
)

func (a *API) searchFullText(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(query) < 2 || utf8.RuneCountInString(query) > 200 || strings.ContainsRune(query, 0) {
		writeError(w, 400, "invalid_text_query", "请输入 2–200 字的正文关键词。")
		return
	}
	page, _, err := parsePagination(r, 24, 24)
	if err != nil || page > 50 {
		writeError(w, 400, "invalid_pagination", "正文检索最多查看 50 页，请细化关键词。")
		return
	}
	result, err := a.store.SearchText(r.Context(), sessionFromContext(r.Context()).User.ID, query, page)
	if err != nil {
		writeError(w, 503, "text_search_unavailable", "正文检索超时或暂不可用，请细化关键词后重试。")
		return
	}
	writeJSON(w, 200, result)
}
func (a *API) textIndexStatus(w http.ResponseWriter, r *http.Request) {
	result, err := a.store.TextIndexStatus(r.Context(), sessionFromContext(r.Context()).User.ID)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
func (a *API) buildTextIndex(w http.ResponseWriter, r *http.Request) {
	count, err := textindex.EnqueueMissing(r.Context(), a.store)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, 202, map[string]any{"queued": count})
}
