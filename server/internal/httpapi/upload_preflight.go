package httpapi

import (
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
)

func (a *API) preflightUploads(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Sizes []int64 `json:"sizes"`
	}
	if err := readJSON(w, r, &body, 32<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_preflight", err.Error())
		return
	}
	if len(body.Sizes) == 0 || len(body.Sizes) > 1000 {
		writeError(w, http.StatusBadRequest, "invalid_sizes", "provide between 1 and 1000 file sizes")
		return
	}
	for _, size := range body.Sizes {
		if size < 0 {
			writeError(w, http.StatusBadRequest, "invalid_sizes", "file size must not be negative")
			return
		}
	}
	sizes, err := a.store.ManagedUploadSizes(r.Context(), body.Sizes)
	if err != nil {
		a.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"matchingSizes": sizes})
}

func (a *API) skipDuplicateUpload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SHA256   string `json:"sha256"`
		Size     int64  `json:"size"`
		Filename string `json:"filename"`
		BatchID  int64  `json:"batchId"`
		ItemKey  string `json:"itemKey"`
	}
	if err := readJSON(w, r, &body, 8<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_preflight", err.Error())
		return
	}
	hash, err := hex.DecodeString(body.SHA256)
	if err != nil || len(hash) != 32 || body.Size <= 0 || body.BatchID <= 0 || len(body.ItemKey) == 0 || len(body.ItemKey) > 128 || len(body.Filename) > 1024 || strings.TrimSpace(body.Filename) == "" {
		writeError(w, http.StatusBadRequest, "invalid_preflight", "valid hash, size, filename, batchId and itemKey are required")
		return
	}
	book, found, err := a.store.GetManagedBookByHash(r.Context(), hash)
	if err != nil {
		a.internalError(w, err)
		return
	}
	// A catalog record with a missing managed file must not block a repair upload.
	if found && book.SizeBytes == body.Size && a.library != nil {
		path, resolveErr := a.library.Resolve(book.StoragePath)
		if resolveErr == nil {
			info, statErr := os.Stat(path)
			if statErr == nil && info.Mode().IsRegular() && info.Size() == body.Size {
				jobID, err := a.store.RecordSkippedUpload(r.Context(), sessionFromContext(r.Context()).User.ID, body.BatchID, book.ID, body.ItemKey, body.Filename)
				if errors.Is(err, pgx.ErrNoRows) {
					writeError(w, http.StatusBadRequest, "invalid_batch", "import batch not found")
					return
				}
				if err != nil {
					a.internalError(w, err)
					return
				}
				a.decorateBook(&book)
				writeJSON(w, http.StatusOK, map[string]any{"duplicate": true, "bookFile": book, "importJobId": jobID})
				return
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"duplicate": false})
}
