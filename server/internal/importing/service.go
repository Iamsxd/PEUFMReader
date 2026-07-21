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
	"peufmreader/internal/mobiconvert"
	"peufmreader/internal/pdfassets"
	"peufmreader/internal/store"
)

var (
	ErrMetadataExtraction = errors.New("ebook metadata extraction failed")
	ErrReadableConversion = errors.New("ebook could not be converted for browser reading")
)

type Service struct {
	store      *store.Store
	library    *library.Manager
	converter  *mobiconvert.Converter
	postImport func(context.Context, int64, store.BookFile) error
}

type Result struct {
	Book        store.BookFile
	Duplicate   bool
	ImportJobID int64
}

func New(store *store.Store, libraryManager *library.Manager, converter *mobiconvert.Converter) *Service {
	return &Service{store: store, library: libraryManager, converter: converter}
}

func (s *Service) SetPostImportHook(hook func(context.Context, int64, store.BookFile) error) {
	s.postImport = hook
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
	failJob := func(failure error) (Result, error) {
		_ = s.store.FailImportJob(ctx, job.ID, failure)
		return Result{}, failure
	}

	stored, err := s.library.Ingest(originalFilename, reader)
	if err != nil {
		return failJob(err)
	}
	converted := mobiconvert.Result{}
	failImport := func(failure error) (Result, error) {
		if s.converter != nil {
			s.converter.RemoveIfCreated(converted)
		}
		s.library.RemoveIfCreated(stored)
		return failJob(failure)
	}
	metadataPath := stored.AbsolutePath
	metadataFormat := stored.Format
	if mobiconvert.IsKindleFormat(stored.Format) {
		if s.converter == nil {
			return failImport(fmt.Errorf("%w: converter is not configured", ErrReadableConversion))
		}
		converted, err = s.converter.EnsureEPUB(ctx, stored.AbsolutePath, stored.Format, stored.SHA256Hex)
		if err != nil {
			return failImport(fmt.Errorf("%w: %v", ErrReadableConversion, err))
		}
		metadataPath = converted.Path
		metadataFormat = "epub"
	}
	extracted, err := metadata.Extract(metadataPath, metadataFormat, stored.OriginalFilename)
	if err != nil {
		return failImport(fmt.Errorf("%w: %v", ErrMetadataExtraction, err))
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
		classify(s.store, ctx, extracted),
		coverPath,
		userID,
		job.ID,
	)
	if err != nil {
		return failImport(err)
	}
	if duplicate && stored.Created && book.StoragePath != stored.RelativePath {
		s.library.RemoveIfCreated(stored)
	}
	if book.Format == "pdf" && (!duplicate || book.PageCount == nil) {
		if _, _, enqueueErr := pdfassets.Enqueue(ctx, s.store, &userID, book.ID); enqueueErr != nil {
			_ = s.store.AppendImportJobWarning(ctx, job.ID, "PDF 封面/OCR 后台任务排队失败："+enqueueErr.Error())
		}
	}
	if !duplicate && s.postImport != nil {
		if hookErr := s.postImport(ctx, userID, book); hookErr != nil {
			_ = s.store.AppendImportJobWarning(ctx, job.ID, "外部书目自动查询任务排队失败："+hookErr.Error())
		}
	}
	return Result{Book: book, Duplicate: duplicate, ImportJobID: job.ID}, nil
}

func classify(dataStore *store.Store, ctx context.Context, extracted metadata.Result) []classification.Suggestion {
	rules, err := dataStore.EnabledClassificationRules(ctx)
	if err != nil {
		return classification.Classify(extracted)
	}
	return classification.ClassifyWithRules(extracted, rules)
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
