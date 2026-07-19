package importing

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"peufmreader/internal/classification"
	"peufmreader/internal/library"
	"peufmreader/internal/metadata"
	"peufmreader/internal/pdfassets"
	"peufmreader/internal/store"
)

var ErrMetadataExtraction = errors.New("ebook metadata extraction failed")

type Service struct {
	store   *store.Store
	library *library.Manager
}

type Result struct {
	Book        store.BookFile
	Duplicate   bool
	ImportJobID int64
}

func New(store *store.Store, libraryManager *library.Manager) *Service {
	return &Service{store: store, library: libraryManager}
}

func (s *Service) Import(
	ctx context.Context,
	userID int64,
	sourceName string,
	originalFilename string,
	reader io.Reader,
	override *metadata.Result,
) (Result, error) {
	job, err := s.store.CreateImportJob(ctx, userID, sourceName)
	if err != nil {
		return Result{}, err
	}
	fail := func(failure error) (Result, error) {
		_ = s.store.FailImportJob(ctx, job.ID, failure)
		return Result{}, failure
	}

	stored, err := s.library.Ingest(originalFilename, reader)
	if err != nil {
		return fail(err)
	}
	extracted, err := metadata.Extract(stored.AbsolutePath, stored.Format, stored.OriginalFilename)
	if err != nil {
		s.library.RemoveIfCreated(stored)
		return fail(fmt.Errorf("%w: %v", ErrMetadataExtraction, err))
	}
	if override != nil {
		extracted = mergeMetadata(extracted, *override)
	}

	coverPath := ""
	if extracted.Cover != nil {
		coverPath, err = s.library.StoreCover(stored.SHA256Hex, extracted.Cover.Extension, extracted.Cover.Bytes)
		if err != nil {
			extracted.Warnings = append(extracted.Warnings, "封面缓存失败："+err.Error())
			coverPath = ""
		}
	}
	book, duplicate, err := s.store.RegisterImportedBook(
		ctx,
		stored,
		extracted,
		classification.Classify(extracted),
		coverPath,
		userID,
		job.ID,
	)
	if err != nil {
		s.library.RemoveIfCreated(stored)
		return fail(err)
	}
	if book.Format == "pdf" && (!duplicate || book.PageCount == nil) {
		if _, _, enqueueErr := pdfassets.Enqueue(ctx, s.store, &userID, book.ID); enqueueErr != nil {
			_ = s.store.AppendImportJobWarning(ctx, job.ID, "PDF 封面/OCR 后台任务排队失败："+enqueueErr.Error())
		}
	}
	return Result{Book: book, Duplicate: duplicate, ImportJobID: job.ID}, nil
}

func mergeMetadata(embedded, preferred metadata.Result) metadata.Result {
	result := embedded
	if strings.TrimSpace(preferred.Title) != "" {
		result.Title = preferred.Title
	}
	if len(preferred.Authors) > 0 {
		result.Authors = preferred.Authors
	}
	if preferred.PublishedYear != nil {
		result.PublishedYear = preferred.PublishedYear
	}
	if preferred.Language != "" {
		result.Language = preferred.Language
	}
	if preferred.ISBN != "" {
		result.ISBN = preferred.ISBN
	}
	if preferred.Publisher != "" {
		result.Publisher = preferred.Publisher
	}
	if preferred.Description != "" {
		result.Description = preferred.Description
	}
	if len(preferred.Subjects) > 0 {
		result.Subjects = preferred.Subjects
	}
	if preferred.Cover != nil {
		result.Cover = preferred.Cover
	}
	result.Source = preferred.Source
	result.Confidence = max(embedded.Confidence, preferred.Confidence)
	result.Warnings = append(result.Warnings, preferred.Warnings...)
	if result.Title == "" {
		result.Title = "Untitled"
		result.Warnings = append(result.Warnings, fmt.Sprintf("%s 未提供书名", preferred.Source))
	}
	return result
}
