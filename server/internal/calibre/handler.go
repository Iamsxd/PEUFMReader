package calibre

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"peufmreader/internal/importing"
	"peufmreader/internal/jobs"
	"peufmreader/internal/store"
)

const ImportJobKind = "calibre-import"

type ImportPayload struct {
	SourcePath string `json:"sourcePath"`
}

func ImportHandler(scanner *Scanner, importer *importing.Service) jobs.Handler {
	return func(ctx context.Context, job store.BackgroundJob) (any, error) {
		if job.CreatedBy == nil {
			return nil, errors.New("Calibre import job has no initiating user")
		}
		var payload ImportPayload
		if err := json.Unmarshal(job.Payload, &payload); err != nil || payload.SourcePath == "" {
			return nil, errors.New("Calibre import job payload is invalid")
		}
		record, absoluteSource, err := scanner.Load(payload.SourcePath)
		if err != nil {
			return nil, fmt.Errorf("load Calibre record: %w", err)
		}
		preferred, err := scanner.Metadata(record)
		if err != nil {
			return nil, err
		}
		file, err := os.Open(absoluteSource)
		if err != nil {
			return nil, fmt.Errorf("open Calibre ebook: %w", err)
		}
		defer file.Close()

		result, err := importer.Import(
			ctx,
			*job.CreatedBy,
			"Calibre: "+record.Title,
			filepath.Base(absoluteSource),
			file,
			&preferred,
		)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"bookFileId":  result.Book.ID,
			"title":       result.Book.Title,
			"duplicate":   result.Duplicate,
			"importJobId": result.ImportJobID,
		}, nil
	}
}
