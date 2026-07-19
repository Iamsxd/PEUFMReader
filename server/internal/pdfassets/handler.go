package pdfassets

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"peufmreader/internal/jobs"
	"peufmreader/internal/library"
	"peufmreader/internal/store"
)

type Payload struct {
	BookFileID int64 `json:"bookFileId"`
}

func Enqueue(ctx context.Context, dataStore *store.Store, createdBy *int64, bookFileID int64) (store.BackgroundJob, bool, error) {
	return dataStore.EnqueueBackgroundJob(
		ctx, JobKind, strconv.FormatInt(bookFileID, 10), Payload{BookFileID: bookFileID}, createdBy, &bookFileID, 3,
	)
}

func EnqueueMissing(ctx context.Context, dataStore *store.Store, limit int) (int, error) {
	ids, err := dataStore.ListPDFsMissingAssets(ctx, limit)
	if err != nil {
		return 0, err
	}
	queued := 0
	for _, id := range ids {
		_, created, enqueueErr := Enqueue(ctx, dataStore, nil, id)
		if enqueueErr != nil {
			return queued, enqueueErr
		}
		if created {
			queued++
		}
	}
	return queued, nil
}

func Handler(dataStore *store.Store, libraryManager *library.Manager, processor *Processor) jobs.Handler {
	return func(ctx context.Context, job store.BackgroundJob) (any, error) {
		var payload Payload
		if err := json.Unmarshal(job.Payload, &payload); err != nil || payload.BookFileID <= 0 {
			return nil, errors.New("PDF asset job payload is invalid")
		}
		book, found, err := dataStore.GetCatalogBook(ctx, payload.BookFileID)
		if err != nil {
			return nil, err
		}
		if !found || book.Format != "pdf" {
			return nil, fmt.Errorf("PDF book file %d not found", payload.BookFileID)
		}
		absolutePath, err := libraryManager.Resolve(book.StoragePath)
		if err != nil {
			return nil, err
		}
		processed, err := processor.Process(ctx, absolutePath)
		if err != nil {
			return nil, err
		}
		hash := hex.EncodeToString(book.SHA256)
		coverPath, err := libraryManager.StoreCover(hash, "jpg", processed.Cover)
		if err != nil {
			return nil, err
		}
		textPath := ""
		if len(processed.Text) > 0 {
			textPath, err = libraryManager.StoreExtractedText(hash, processed.Text)
			if err != nil {
				return nil, err
			}
		}
		if err := dataStore.UpdatePDFAssets(ctx, book.ID, coverPath, textPath, processed.TextMethod, processed.PageCount); err != nil {
			return nil, err
		}
		return map[string]any{
			"bookFileId": book.ID, "coverPath": coverPath, "textPath": textPath,
			"textMethod": processed.TextMethod, "pageCount": processed.PageCount,
			"ocrUsed": processed.OCRUsed, "warnings": processed.Warnings,
		}, nil
	}
}
