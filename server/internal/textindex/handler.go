package textindex

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"

	"peufmreader/internal/calibre"
	"peufmreader/internal/jobs"
	"peufmreader/internal/library"
	"peufmreader/internal/store"
)

const JobKind = "text-index"

type Payload struct {
	BookFileID int64 `json:"bookFileId"`
}

func Enqueue(ctx context.Context, s *store.Store, book store.BookFile) (bool, error) {
	key := strconv.FormatInt(book.ID, 10) + ":" + hex.EncodeToString(book.SHA256) + ":" + book.TextPath + ":" + book.TextMethod + ":v1"
	_, created, err := s.EnqueueBackgroundJob(ctx, JobKind, key, Payload{book.ID}, nil, &book.ID, 3)
	return created, err
}
func EnqueueMissing(ctx context.Context, s *store.Store) (int, error) {
	books, err := s.TextIndexCandidates(ctx, 10000)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, book := range books {
		created, err := Enqueue(ctx, s, book)
		if err != nil {
			return count, err
		}
		if created {
			count++
		}
	}
	return count, nil
}
func Handler(s *store.Store, libraryManager *library.Manager, scanner *calibre.Scanner) jobs.Handler {
	return func(ctx context.Context, job store.BackgroundJob) (any, error) {
		var payload Payload
		if err := job.DecodePayload(&payload); err != nil {
			return nil, err
		}
		book, found, err := s.GetCatalogBook(ctx, payload.BookFileID)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, errors.New("indexed book no longer exists")
		}
		_ = jobs.ReportProgress(ctx, 10, "读取本地正文，不发送到外部服务")
		var passages []store.SearchPassage
		var coverage string
		if book.Format == "epub" {
			var file *os.File
			if book.StorageMode == "calibre-reference" {
				if scanner == nil {
					return nil, errors.New("Calibre is unavailable")
				}
				file, err = scanner.Open(book.ReferencePath)
			} else {
				var absolute string
				absolute, err = libraryManager.Resolve(book.StoragePath)
				if err == nil {
					file, err = os.Open(absolute)
				}
			}
			if err != nil {
				return nil, fmt.Errorf("open EPUB for indexing: %w", err)
			}
			defer file.Close()
			stat, err := file.Stat()
			if err != nil {
				return nil, err
			}
			passages, coverage, err = EPUB(file, stat.Size())
		} else if book.Format == "pdf" && book.TextPath != "" {
			absolute, resolveErr := libraryManager.ResolveExtractedText(book.TextPath)
			if resolveErr != nil {
				return nil, resolveErr
			}
			file, openErr := os.Open(absolute)
			if openErr != nil {
				return nil, openErr
			}
			defer file.Close()
			data, readErr := io.ReadAll(io.LimitReader(file, MaxTextBytes+1))
			if readErr != nil {
				return nil, readErr
			}
			pageCount := 0
			if book.PageCount != nil {
				pageCount = *book.PageCount
			}
			passages, coverage, err = PDF(data, book.TextMethod, pageCount)
		} else {
			return nil, errors.New("no supported text available; OCR is not started automatically")
		}
		if err != nil {
			return nil, err
		}
		_ = jobs.ReportProgress(ctx, 70, "事务替换正文索引")
		if err = s.ReplaceTextIndex(ctx, book, coverage, passages); err != nil {
			return nil, err
		}
		return map[string]any{"bookFileId": book.ID, "passages": len(passages), "coverage": coverage}, nil
	}
}
