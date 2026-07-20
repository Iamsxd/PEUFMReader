package bibliographyjobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"peufmreader/internal/bibliography"
	"peufmreader/internal/jobs"
	"peufmreader/internal/store"
)

const JobKind = "bibliography-enrichment"

type Payload struct {
	EditionID int64 `json:"editionId"`
}

func EnqueueIfConfigured(ctx context.Context, dataStore *store.Store, userID int64, book store.BookFile) error {
	sources, err := dataStore.ListEnabledBibliographySources(ctx, true)
	if err != nil {
		return err
	}
	if len(sources) == 0 {
		return nil
	}
	_, _, err = dataStore.EnqueueBackgroundJob(ctx, JobKind, strconv.FormatInt(book.EditionID, 10),
		Payload{EditionID: book.EditionID}, &userID, &book.ID, 3)
	return err
}

func Handler(dataStore *store.Store, service *bibliography.Service) jobs.Handler {
	return func(ctx context.Context, job store.BackgroundJob) (any, error) {
		var payload Payload
		if err := json.Unmarshal(job.Payload, &payload); err != nil || payload.EditionID <= 0 {
			return nil, errors.New("invalid bibliography enrichment payload")
		}
		if err := jobs.ReportProgress(ctx, 15, "正在读取书籍元数据"); err != nil {
			return nil, err
		}
		book, found, err := dataStore.EditionMetadata(ctx, payload.EditionID)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, fmt.Errorf("edition %d not found", payload.EditionID)
		}
		if err := jobs.ReportProgress(ctx, 35, "正在查询外部书目信息源"); err != nil {
			return nil, err
		}
		result, err := service.SearchAutomatic(ctx, bibliography.Query{
			Title: book.Title, Authors: book.Authors, ISBN: book.ISBN, Language: book.Language,
		})
		if errors.Is(err, bibliography.ErrNoProviders) {
			return map[string]any{"matches": 0, "warnings": []string{"没有启用自动查询的信息源"}}, nil
		}
		if err != nil {
			return nil, err
		}
		if err := dataStore.AddBibliographySuggestions(ctx, payload.EditionID, result.Matches); err != nil {
			return nil, err
		}
		if err := jobs.ReportProgress(ctx, 90, "正在保存书目建议"); err != nil {
			return nil, err
		}
		return map[string]any{"matches": len(result.Matches), "warnings": result.Warnings}, nil
	}
}
