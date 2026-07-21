package store

import (
	"context"
	"fmt"

	"peufmreader/internal/classification"
)

func (s *Store) ListUnclassifiedEditionIDs(ctx context.Context) ([]int64, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT e.id
		FROM editions e
		WHERE EXISTS (SELECT 1 FROM book_files bf WHERE bf.edition_id=e.id)
		  AND NOT EXISTS (
			SELECT 1 FROM classification_decisions cd
			WHERE cd.edition_id=e.id AND cd.status='accepted'
		  )
		ORDER BY e.id`)
	if err != nil {
		return nil, fmt.Errorf("list unclassified editions: %w", err)
	}
	defer rows.Close()
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ReplaceAutomaticClassification replaces only deterministic decisions. It never
// changes an edition that already has an accepted manual category.
func (s *Store) ReplaceAutomaticClassification(ctx context.Context, editionID int64, suggestions []classification.Suggestion) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var hasManual bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM classification_decisions
		WHERE edition_id=$1 AND status='accepted' AND source='manual'
	)`, editionID).Scan(&hasManual); err != nil {
		return false, err
	}
	if hasManual {
		return false, nil
	}
	incomingAccepted := false
	for _, suggestion := range suggestions {
		if suggestion.Status == "accepted" {
			incomingAccepted = true
			break
		}
	}
	if !incomingAccepted {
		var hasAcceptedAutomatic bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM classification_decisions
			WHERE edition_id=$1 AND status='accepted'
			  AND (source LIKE 'deterministic-rules-v%' OR source LIKE 'bibliography-rules-v2:%')
		)`, editionID).Scan(&hasAcceptedAutomatic); err != nil {
			return false, err
		}
		if hasAcceptedAutomatic {
			return false, nil
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE classification_decisions
		SET status='rejected',decided_by=NULL,updated_at=now()
		WHERE edition_id=$1 AND (source LIKE 'deterministic-rules-v%' OR source LIKE 'bibliography-rules-v2:%')`, editionID); err != nil {
		return false, fmt.Errorf("retire old automatic classifications: %w", err)
	}
	for _, suggestion := range suggestions {
		command, err := tx.Exec(ctx, `
			INSERT INTO classification_decisions(edition_id,category_id,source,confidence,reason,status)
			SELECT $1,id,$2,$3,$4,$5 FROM categories WHERE slug=$6 AND active=true
			ON CONFLICT (edition_id,category_id,source) DO UPDATE SET
				confidence=EXCLUDED.confidence,reason=EXCLUDED.reason,status=EXCLUDED.status,
				decided_by=NULL,updated_at=now()`,
			editionID, suggestion.Source, suggestion.Confidence, suggestion.Reason, suggestion.Status, suggestion.CategorySlug)
		if err != nil {
			return false, fmt.Errorf("save refreshed classification: %w", err)
		}
		if command.RowsAffected() == 0 {
			return false, fmt.Errorf("unknown or inactive category %q", suggestion.CategorySlug)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}
