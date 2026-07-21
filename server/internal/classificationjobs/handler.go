package classificationjobs

import (
	"context"
	"errors"
	"strings"

	"peufmreader/internal/classification"
	"peufmreader/internal/jobs"
	"peufmreader/internal/store"
)

const JobKind = "classification-refresh"

type Payload struct {
	Scope string `json:"scope"`
}

func Handler(dataStore *store.Store) jobs.Handler {
	return func(ctx context.Context, job store.BackgroundJob) (any, error) {
		var payload Payload
		if err := job.DecodePayload(&payload); err != nil {
			return nil, err
		}
		if strings.TrimSpace(payload.Scope) != "unclassified" {
			return nil, errors.New("unsupported classification refresh scope")
		}
		rules, err := dataStore.EnabledClassificationRules(ctx)
		if err != nil {
			return nil, err
		}
		editionIDs, err := dataStore.ListUnclassifiedEditionIDs(ctx)
		if err != nil {
			return nil, err
		}
		updated, matched, unmatched, skipped := 0, 0, 0, 0
		for index, editionID := range editionIDs {
			if len(editionIDs) > 0 {
				progress := 5 + index*90/len(editionIDs)
				if err := jobs.ReportProgress(ctx, progress, "正在重新分析未分类书籍"); err != nil {
					return nil, err
				}
			}
			book, found, err := dataStore.EditionMetadata(ctx, editionID)
			if err != nil {
				return nil, err
			}
			if !found {
				skipped++
				continue
			}
			suggestions := classification.ClassifyWithRules(book, rules)
			changed, err := dataStore.ReplaceAutomaticClassification(ctx, editionID, suggestions)
			if err != nil {
				return nil, err
			}
			if !changed {
				skipped++
				continue
			}
			updated++
			if hasAccepted(suggestions) {
				matched++
			} else {
				unmatched++
			}
		}
		return map[string]any{
			"scope": "unclassified", "total": len(editionIDs), "updated": updated,
			"matched": matched, "unmatched": unmatched, "skipped": skipped,
		}, nil
	}
}

func hasAccepted(suggestions []classification.Suggestion) bool {
	for _, suggestion := range suggestions {
		if suggestion.Status == "accepted" {
			return true
		}
	}
	return false
}
