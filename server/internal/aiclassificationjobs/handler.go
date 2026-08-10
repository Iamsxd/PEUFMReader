package aiclassificationjobs

import (
	"context"
	"errors"
	"fmt"
	"time"

	"peufmreader/internal/classification"
	"peufmreader/internal/jobs"
	"peufmreader/internal/metadata"
	"peufmreader/internal/store"
)

const (
	JobKind           = "ai-classification-batch"
	ScopeUnclassified = "unclassified"
	MaxBatchSize      = 5000
	requestSpacing    = 200 * time.Millisecond
)

type Payload struct {
	Scope string `json:"scope"`
	Limit int    `json:"limit"`
}

type Result struct {
	Scope               string   `json:"scope"`
	Total               int      `json:"total"`
	SuggestedBooks      int      `json:"suggestedBooks"`
	SuggestedCategories int      `json:"suggestedCategories"`
	Skipped             int      `json:"skipped"`
	Failed              int      `json:"failed"`
	FailureSamples      []string `json:"failureSamples,omitempty"`
}

type Repository interface {
	ListUnclassifiedEditionIDsLimit(context.Context, int) ([]int64, error)
	IsEditionUnclassified(context.Context, int64) (bool, error)
	EditionMetadata(context.Context, int64) (metadata.Result, bool, error)
	AddClassificationSuggestions(context.Context, int64, []classification.Suggestion) error
	ListCategories(context.Context) ([]store.Category, error)
}

type Advisor interface {
	Suggest(context.Context, metadata.Result, []classification.CategoryOption) ([]classification.Suggestion, error)
}

func Handler(dataStore Repository, advisor Advisor) jobs.Handler {
	return func(ctx context.Context, job store.BackgroundJob) (any, error) {
		if advisor == nil {
			return nil, errors.New("AI classification is not configured")
		}
		var payload Payload
		if err := job.DecodePayload(&payload); err != nil {
			return nil, err
		}
		if payload.Scope != ScopeUnclassified {
			return nil, errors.New("unsupported AI classification scope")
		}
		if payload.Limit < 1 || payload.Limit > MaxBatchSize {
			return nil, fmt.Errorf("AI classification batch limit must be between 1 and %d", MaxBatchSize)
		}

		editionIDs, err := dataStore.ListUnclassifiedEditionIDsLimit(ctx, payload.Limit)
		if err != nil {
			return nil, err
		}
		categories, err := dataStore.ListCategories(ctx)
		if err != nil {
			return nil, err
		}
		options := categoryOptions(categories)
		if len(options) == 0 {
			return nil, errors.New("no active categories are available for AI classification")
		}

		result := Result{Scope: payload.Scope, Total: len(editionIDs)}
		if err := jobs.ReportProgress(ctx, 3, "正在准备 AI 分类批次"); err != nil {
			return nil, err
		}
		for index, editionID := range editionIDs {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			eligible, err := dataStore.IsEditionUnclassified(ctx, editionID)
			if err != nil {
				return nil, err
			}
			if !eligible {
				result.Skipped++
				continue
			}
			book, found, err := dataStore.EditionMetadata(ctx, editionID)
			if err != nil {
				return nil, err
			}
			if !found {
				result.Skipped++
				continue
			}
			suggestions, err := advisor.Suggest(ctx, book, options)
			if err != nil {
				result.Failed++
				if len(result.FailureSamples) < 5 {
					result.FailureSamples = append(result.FailureSamples, fmt.Sprintf("第 %d 项未获得可用建议", index+1))
				}
			} else if err := dataStore.AddClassificationSuggestions(ctx, editionID, suggestions); err != nil {
				return nil, err
			} else {
				result.SuggestedBooks++
				result.SuggestedCategories += len(suggestions)
			}

			if (index+1)%5 == 0 || index+1 == len(editionIDs) {
				progress := 5 + (index+1)*94/max(1, len(editionIDs))
				if err := jobs.ReportProgress(ctx, progress, fmt.Sprintf("正在请求 AI 分类：已处理 %d / %d", index+1, len(editionIDs))); err != nil {
					return nil, err
				}
			}
			if index+1 < len(editionIDs) {
				if err := wait(ctx, requestSpacing); err != nil {
					return nil, err
				}
			}
		}
		if result.Total > 0 && result.Failed == result.Total {
			return nil, errors.New("AI provider did not return usable classification suggestions")
		}
		return result, nil
	}
}

func categoryOptions(categories []store.Category) []classification.CategoryOption {
	options := make([]classification.CategoryOption, 0, len(categories))
	for _, category := range categories {
		if !category.Active {
			continue
		}
		options = append(options, classification.CategoryOption{
			Slug: category.Slug, Name: category.Name, ParentName: category.ParentName,
		})
	}
	return options
}

func wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
