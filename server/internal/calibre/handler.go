package calibre

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"

	"peufmreader/internal/classification"
	"peufmreader/internal/importing"
	"peufmreader/internal/jobs"
	"peufmreader/internal/library"
	"peufmreader/internal/metadata"
	"peufmreader/internal/store"
)

const (
	ImportJobKind        = "calibre-import"
	ReferenceSyncJobKind = "calibre-reference-sync"
)

type ImportPayload struct {
	SourcePath string  `json:"sourcePath"`
	Record     *Record `json:"record,omitempty"`
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
		_ = jobs.ReportProgress(ctx, 10, "读取 Calibre 书目")
		record := Record{}
		if payload.Record != nil {
			record = *payload.Record
		} else {
			loaded, _, err := scanner.Load(payload.SourcePath)
			if err != nil {
				return nil, fmt.Errorf("load Calibre record: %w", err)
			}
			record = loaded
		}
		preferred, err := scanner.Metadata(record)
		if err != nil {
			return nil, err
		}
		_ = jobs.ReportProgress(ctx, 35, "提取书目与封面")
		file, err := scanner.Open(record.SourcePath)
		if err != nil {
			return nil, fmt.Errorf("open Calibre ebook: %w", err)
		}
		defer file.Close()

		_ = jobs.ReportProgress(ctx, 50, "复制文件并生成分类")
		result, err := importer.Import(
			ctx,
			*job.CreatedBy,
			"Calibre: "+record.Title,
			filepath.Base(file.Name()),
			file,
			&preferred,
			nil,
		)
		if err != nil {
			return nil, err
		}
		_ = jobs.ReportProgress(ctx, 95, "完成 Calibre 迁移")
		return map[string]any{
			"bookFileId":  result.Book.ID,
			"title":       result.Book.Title,
			"duplicate":   result.Duplicate,
			"importJobId": result.ImportJobID,
		}, nil
	}
}

// ReferenceSyncHandler indexes a Calibre library without ingesting ebook
// bytes. It may write catalogue rows and a small cover cache only; all reader
// content continues to be served from the read-only Calibre mount.
func ReferenceSyncHandler(scanner *Scanner, dataStore *store.Store, libraryManager *library.Manager) jobs.Handler {
	return func(ctx context.Context, job store.BackgroundJob) (any, error) {
		if dataStore == nil || libraryManager == nil {
			return nil, errors.New("Calibre reference sync is not configured")
		}
		preview, err := scanner.Preview(10000)
		if err != nil {
			return nil, fmt.Errorf("scan Calibre reference library: %w", err)
		}
		if !preview.Configured {
			return nil, errors.New("Calibre library root is not configured")
		}
		created, refreshed, skipped := 0, 0, 0
		warnings := append([]string{}, preview.Errors...)
		_ = jobs.ReportProgress(ctx, 2, "扫描 Calibre 只读引用书库")
		for index, record := range preview.Books {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			preferred, metadataErr := scanner.Metadata(record)
			if metadataErr != nil {
				// A book may be edited in Calibre while it is being synced. Keep the
				// catalogue run resilient and let the next sync retry its cover.
				preferred = metadata.Result{Title: record.Title, Authors: record.Authors, PublishedYear: record.PublishedYear, Language: record.Language, ISBN: record.ISBN, Publisher: record.Publisher, Description: record.Description, Source: "calibre-metadata-db", Confidence: 0.99}
			}
			// Calibre tags/subjects never become PEUFMReader source subjects,
			// navigation categories, or automatic classification input.
			preferred.Subjects = []string{}
			coverPath := ""
			if preferred.Cover != nil {
				fingerprint := sha256.Sum256([]byte("calibre-reference:v1\x00" + record.ReferenceKey))
				coverPath, _ = libraryManager.StoreCover(fmt.Sprintf("%x", fingerprint[:]), preferred.Cover.Extension, preferred.Cover.Bytes)
			}
			reference := store.CalibreReference{
				ReferenceKey: record.ReferenceKey, ReferencePath: record.SourcePath, OriginalFilename: filepath.Base(record.SourcePath),
				Format: record.OriginalFormat, MIMEType: mimeType(record.OriginalFormat), SizeBytes: record.SizeBytes,
			}
			if reference.ReferenceKey == "" {
				reference.ReferenceKey = "path:" + record.SourcePath
			}
			suggestions := classifyForReference(ctx, dataStore, preferred)
			_, wasCreated, registerErr := dataStore.RegisterCalibreReference(ctx, reference, preferred, suggestions, coverPath)
			if registerErr != nil {
				skipped++
				if len(warnings) < 100 {
					warnings = append(warnings, fmt.Sprintf("%s: %v", record.SourcePath, registerErr))
				}
				continue
			}
			if wasCreated {
				created++
			} else {
				refreshed++
			}
			if index%25 == 0 || index+1 == len(preview.Books) {
				_ = jobs.ReportProgress(ctx, 3+(index+1)*96/max(1, len(preview.Books)), fmt.Sprintf("已处理 %d / %d 个 Calibre 引用", index+1, len(preview.Books)))
			}
		}
		return map[string]any{"total": preview.Total, "created": created, "refreshed": refreshed, "skipped": skipped, "warnings": warnings}, nil
	}
}

func classifyForReference(ctx context.Context, dataStore *store.Store, preferred metadata.Result) []classification.Suggestion {
	rules, err := dataStore.EnabledClassificationRules(ctx)
	if err != nil {
		return classification.Classify(metadata.Result{Title: preferred.Title, Authors: preferred.Authors, Description: preferred.Description})
	}
	// Do not pass Calibre tags as Subjects. PEUFMReader's own fixed categories
	// and administrator-managed rules remain the only classification source.
	preferred.Subjects = nil
	return classification.ClassifyWithRules(preferred, rules)
}

func mimeType(format string) string {
	switch format {
	case "pdf":
		return "application/pdf"
	case "epub":
		return "application/epub+zip"
	case "mobi":
		return "application/x-mobipocket-ebook"
	case "azw3":
		return "application/vnd.amazon.ebook"
	default:
		return "application/octet-stream"
	}
}
