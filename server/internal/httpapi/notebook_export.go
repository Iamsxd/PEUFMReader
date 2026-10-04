package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"peufmreader/internal/store"
)

func parseNotebookFilters(w http.ResponseWriter, r *http.Request) (store.NotebookQuery, bool) {
	values := r.URL.Query()
	query := store.NotebookQuery{Query: strings.TrimSpace(values.Get("q")), Kind: values.Get("kind"), Color: values.Get("color")}
	if utf8.RuneCountInString(query.Query) > 200 || (query.Kind != "" && query.Kind != "note" && query.Kind != "highlight" && query.Kind != "bookmark") || (query.Color != "" && !validHighlightColor(query.Color)) {
		writeError(w, 400, "invalid_notebook_query", "invalid query, kind or color")
		return query, false
	}
	if value := values.Get("bookId"); value != "" {
		var ok bool
		query.BookFileID, ok = parseID(w, value)
		if !ok {
			return query, false
		}
	}
	return query, true
}

type notebookExportFilters struct {
	Query      string `json:"q"`
	Kind       string `json:"kind"`
	Color      string `json:"color"`
	BookFileID int64  `json:"bookId,omitempty"`
}

// This buffer refuses oversized writes before expanding. No partial attachment
// is sent: the handler writes headers only after successful serialization.
type notebookExportBuffer struct {
	bytes.Buffer
	limit int
	err   error
}

func (buffer *notebookExportBuffer) Write(data []byte) (int, error) {
	if buffer.err != nil {
		return 0, buffer.err
	}
	if len(data) > buffer.limit-buffer.Len() {
		buffer.err = store.ErrNotebookExportTooLarge
		return 0, buffer.err
	}
	return buffer.Buffer.Write(data)
}

func (buffer *notebookExportBuffer) WriteString(value string) (int, error) {
	if buffer.err != nil {
		return 0, buffer.err
	}
	if len(value) > buffer.limit-buffer.Len() {
		buffer.err = store.ErrNotebookExportTooLarge
		return 0, buffer.err
	}
	return buffer.Buffer.WriteString(value)
}

var notebookMarkdownEscaper = func() *strings.Replacer {
	pairs := make([]string, 0)
	for character := byte(33); character < 127; character++ {
		if character == '<' {
			pairs = append(pairs, "<", "&lt;")
			continue
		}
		if character == '>' {
			pairs = append(pairs, ">", "&gt;")
			continue
		}
		if character == '&' {
			pairs = append(pairs, "&", "&amp;")
			continue
		}
		if (character >= 33 && character <= 47) || (character >= 58 && character <= 64) || (character >= 91 && character <= 96) || character >= 123 {
			pairs = append(pairs, string(character), "\\"+string(character))
		}
	}
	return strings.NewReplacer(pairs...)
}()

func notebookMarkdownField(output io.Writer, name, value string) {
	fmt.Fprintf(output, "- %s：", name)
	// HTML-sensitive characters become entities and remaining ASCII punctuation
	// is backslash-escaped. User content is always literal text, never HTML/links.
	_, _ = notebookMarkdownEscaper.WriteString(output, value)
	_, _ = io.WriteString(output, "\n")
}

// Estimate escaped string bytes before json.Marshal so a large, malicious title
// made of HTML characters cannot allocate an unbounded escaped temporary buffer.
func notebookJSONStringBytes(value string) int {
	count := 2
	for _, character := range value {
		switch character {
		case '\\', '"', '\b', '\f', '\n', '\r', '\t':
			count += 2
		case '<', '>', '&', '\u2028', '\u2029':
			count += 6
		default:
			if character < 32 {
				count += 6
			} else {
				count += utf8.RuneLen(character)
			}
		}
	}
	return count
}

func renderNotebookExport(items []store.NotebookEntry, query store.NotebookQuery, format string, generatedAt time.Time, byteLimit int) ([]byte, error) {
	output := &notebookExportBuffer{limit: byteLimit}
	filters := notebookExportFilters{Query: query.Query, Kind: query.Kind, Color: query.Color, BookFileID: query.BookFileID}
	if format == "json" {
		metadata, err := json.Marshal(struct {
			Version     int                   `json:"version"`
			GeneratedAt time.Time             `json:"generatedAt"`
			Filters     notebookExportFilters `json:"filters"`
		}{1, generatedAt, filters})
		if err != nil {
			return nil, err
		}
		_, _ = output.Write(metadata[:len(metadata)-1])
		_, _ = output.WriteString(",\"items\":[")
		for index, item := range items {
			minimum := notebookJSONStringBytes(item.BookTitle) + notebookJSONStringBytes(item.BookFormat) + notebookJSONStringBytes(item.Kind) + notebookJSONStringBytes(item.Label) + notebookJSONStringBytes(item.Body) + notebookJSONStringBytes(item.Quote) + notebookJSONStringBytes(item.Color) + len(item.Position)
			if minimum > output.limit-output.Len() {
				return nil, store.ErrNotebookExportTooLarge
			}
			encoded, err := json.Marshal(item)
			if err != nil {
				return nil, err
			}
			if index > 0 {
				_, _ = output.WriteString(",")
			}
			_, _ = output.Write(encoded)
			if output.err != nil {
				return nil, output.err
			}
		}
		_, _ = output.WriteString("]}\n")
	} else {
		_, _ = output.WriteString("# PEUFMReader 阅读笔记\n\n")
		fmt.Fprintf(output, "导出版本：1\n\n生成时间：%s\n\n记录数量：%d\n\n## 导出范围\n\n", generatedAt.Format(time.RFC3339), len(items))
		notebookMarkdownField(output, "关键词", query.Query)
		notebookMarkdownField(output, "记录类型", query.Kind)
		notebookMarkdownField(output, "高亮颜色", query.Color)
		if query.BookFileID > 0 {
			fmt.Fprintf(output, "- 书籍 ID：%d\n", query.BookFileID)
		}
		_, _ = output.WriteString("\n")
		if len(items) == 0 {
			_, _ = output.WriteString("暂无符合筛选条件的阅读记录。\n")
		}
		for _, item := range items {
			_, _ = output.WriteString("## ")
			_, _ = notebookMarkdownEscaper.WriteString(output, item.BookTitle)
			_, _ = output.WriteString("\n\n")
			fmt.Fprintf(output, "- 记录 ID：%d\n- 书籍 ID：%d\n", item.ID, item.BookFileID)
			notebookMarkdownField(output, "书籍格式", item.BookFormat)
			notebookMarkdownField(output, "类型", readingMarkKindName(item.Kind))
			notebookMarkdownField(output, "位置", item.Label)
			notebookMarkdownField(output, "定位数据", string(item.Position))
			notebookMarkdownField(output, "颜色", item.Color)
			fmt.Fprintf(output, "- 阅读进度：%.2f%%\n- 创建时间：%s\n- 更新时间：%s\n\n", item.OverallProgress*100, item.CreatedAt.UTC().Format(time.RFC3339Nano), item.UpdatedAt.UTC().Format(time.RFC3339Nano))
			for _, field := range []struct{ name, value string }{{"摘录", item.Quote}, {"批注", item.Body}} {
				fmt.Fprintf(output, "### %s\n\n", field.name)
				_, _ = notebookMarkdownEscaper.WriteString(output, field.value)
				_, _ = output.WriteString("\n\n")
			}
			if output.err != nil {
				return nil, output.err
			}
		}
	}
	if output.err != nil {
		return nil, output.err
	}
	return output.Bytes(), nil
}

func (a *API) exportNotebook(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format != "markdown" && format != "json" {
		writeError(w, 400, "invalid_export_format", "format must be markdown or json")
		return
	}
	if r.URL.Query().Has("page") || r.URL.Query().Has("pageSize") {
		writeError(w, 400, "invalid_notebook_export_query", "笔记导出包含全部符合筛选的记录，不接受分页参数。")
		return
	}
	query, ok := parseNotebookFilters(w, r)
	if !ok {
		return
	}
	items, err := a.store.ExportNotebook(r.Context(), sessionFromContext(r.Context()).User.ID, query)
	var output []byte
	if err == nil {
		output, err = renderNotebookExport(items, query, format, time.Now().UTC(), store.MaxNotebookExportBytes)
	}
	if errors.Is(err, store.ErrNotebookExportTooLarge) {
		writeError(w, 413, "notebook_export_too_large", "导出最多支持 5000 条记录或 16 MiB，请缩小关键词、类型、颜色或单本书筛选后重试。")
		return
	}
	if err != nil {
		a.internalError(w, err)
		return
	}
	filename, contentType := "notebook.md", "text/markdown; charset=utf-8"
	if format == "json" {
		filename, contentType = "notebook.json", "application/json; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(output)
}
