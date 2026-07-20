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
	CoverOnly  bool  `json:"coverOnly,omitempty"`
	CoverPage  int   `json:"coverPage,omitempty"`
}

func Enqueue(ctx context.Context, dataStore *store.Store, createdBy *int64, bookFileID int64) (store.BackgroundJob, bool, error) {
	return dataStore.EnqueueBackgroundJob(
		ctx, JobKind, strconv.FormatInt(bookFileID, 10), Payload{BookFileID: bookFileID}, createdBy, &bookFileID, 3,
	)
}

func EnqueueCoverRegeneration(ctx context.Context, dataStore *store.Store, createdBy int64, bookFileID int64, pageNumber int) (store.BackgroundJob, bool, error) {
	return dataStore.EnqueueBackgroundJob(
		ctx, JobKind, fmt.Sprintf("%d:cover", bookFileID),
		Payload{BookFileID: bookFileID, CoverOnly: true, CoverPage: pageNumber}, &createdBy, &bookFileID, 3,
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
		_ = jobs.ReportProgress(ctx, 10, "读取 PDF 文件")
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
		if payload.CoverOnly {
			pageNumber := max(payload.CoverPage, 1)
			_ = jobs.ReportProgress(ctx, 35, fmt.Sprintf("渲染 PDF 第 %d 页", pageNumber))
			cover, renderErr := processor.RenderCover(ctx, absolutePath, pageNumber)
			if renderErr != nil {
				return nil, renderErr
			}
			_ = jobs.ReportProgress(ctx, 80, "替换 PDF 封面缓存")
			coverPath, replaceErr := libraryManager.ReplaceCover(hex.EncodeToString(book.SHA256), "jpg", cover)
			if replaceErr != nil {
				return nil, replaceErr
			}
			if updateErr := dataStore.UpdatePDFCover(ctx, book.ID, coverPath); updateErr != nil {
				return nil, updateErr
			}
			return map[string]any{
				"bookFileId": book.ID, "coverPath": coverPath, "coverPage": pageNumber, "coverRegenerated": true,
			}, nil
		}
		processed, err := processor.Process(ctx, absolutePath)
		if err != nil {
			return nil, err
		}
		_ = jobs.ReportProgress(ctx, 75, "保存封面与文本")
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
		_ = jobs.ReportProgress(ctx, 95, "更新 PDF 索引")
		return map[string]any{
			"bookFileId": book.ID, "coverPath": coverPath, "textPath": textPath,
			"textMethod": processed.TextMethod, "pageCount": processed.PageCount,
			"ocrUsed": processed.OCRUsed, "warnings": processed.Warnings,
		}, nil
	}
}
