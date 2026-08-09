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
	batchID *int64,
) (Result, error) {
	job, err := s.store.CreateImportJob(ctx, userID, sourceName, batchID)
	if err != nil {
		return Result{}, err
	}
	failJob := func(failure error) (Result, error) {
		_ = s.store.FailImportJob(ctx, job.ID, importJobFailure(failure))
		return Result{ImportJobID: job.ID}, failure
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
	extracted = metadata.Sanitize(extracted)

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

func importJobFailure(failure error) error {
	switch {
	case errors.Is(failure, library.ErrEmptyEbook):
		return errors.New("文件为空，未收到电子书内容；请确认上传没有被浏览器、反向代理或网络中断")
	case errors.Is(failure, library.ErrInvalidPDF):
		return errors.New("文件名是 PDF，但前 1 KiB 中没有有效的 %PDF-版本 文件头；文件可能损坏、下载不完整，或只是被改成了 .pdf 扩展名")
	case errors.Is(failure, library.ErrInvalidEPUBArchive):
		return errors.New("文件名是 EPUB，但内容不是可读取的 ZIP 容器；文件可能损坏、下载不完整或受 DRM/加密容器保护")
	case errors.Is(failure, library.ErrMissingEPUBContainer):
		return errors.New("EPUB 压缩包中缺少 META-INF/container.xml；这通常是普通 ZIP、打包层级错误或不完整的 EPUB")
	case errors.Is(failure, library.ErrInvalidKindle):
		return errors.New("文件名是 MOBI/AZW3，但没有有效的 BOOKMOBI 文件标识；文件可能损坏、受 DRM 保护或扩展名不正确")
	case errors.Is(failure, library.ErrUnsupportedFormat):
		return errors.New("无法从文件内容识别 PDF、EPUB、MOBI 或 AZW3；请确认没有上传网页下载页、普通压缩包或仅修改扩展名的文件")
	case errors.Is(failure, library.ErrUploadTooLarge):
		return errors.New("文件超过当前配置的单文件上传上限")
	case errors.Is(failure, ErrMetadataExtraction):
		return fmt.Errorf("电子书元数据无法读取：%v", failure)
	case errors.Is(failure, ErrReadableConversion):
		return errors.New("MOBI/AZW3 无法生成浏览器阅读副本，文件可能已损坏或受 DRM 保护")
	default:
		return failure
	}
}

// FailureMessage returns the sanitized reason stored in import reports. It is
// also used by the upload response so the live result and retained history do
// not disagree about why a file was rejected.
func FailureMessage(failure error) string {
	return importJobFailure(failure).Error()
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
