package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

type BatchMetadataPatch struct {
	Language      *string
	Publisher     *string
	PublishedYear *int
	CategorySlugs []string
	CategoryMode  string
}

type DuplicateCatalogItem struct {
	WorkID       int64  `json:"workId"`
	EditionID    int64  `json:"editionId"`
	BookFileID   int64  `json:"bookFileId"`
	Title        string `json:"title"`
	ISBN         string `json:"isbn,omitempty"`
	Format       string `json:"format"`
	OriginalName string `json:"originalFilename"`
}

type DuplicateCatalogGroup struct {
	Kind  string                 `json:"kind"`
	Key   string                 `json:"key"`
	Items []DuplicateCatalogItem `json:"items"`
}

func uniquePositiveIDs(values []int64, limit int) ([]int64, error) {
	seen := make(map[int64]bool)
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if value <= 0 {
			return nil, errors.New("IDs must be positive")
		}
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	if len(result) == 0 || len(result) > limit {
		return nil, fmt.Errorf("between 1 and %d unique IDs are required", limit)
	}
	return result, nil
}

func (s *Store) BatchUpdateMetadata(ctx context.Context, userID int64, editionIDs []int64, patch BatchMetadataPatch) (int, error) {
	editionIDs, err := uniquePositiveIDs(editionIDs, 200)
	if err != nil {
		return 0, err
	}
	if patch.PublishedYear != nil && (*patch.PublishedYear < 0 || *patch.PublishedYear > 9999) {
		return 0, errors.New("published year is invalid")
	}
	if patch.CategoryMode != "" && patch.CategoryMode != "add" && patch.CategoryMode != "replace" {
		return 0, errors.New("category mode must be add or replace")
	}
	if patch.Language == nil && patch.Publisher == nil && patch.PublishedYear == nil && patch.CategoryMode == "" {
		return 0, errors.New("metadata patch is empty")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var existing int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM editions WHERE id=ANY($1)", editionIDs).Scan(&existing); err != nil {
		return 0, err
	}
	if existing != len(editionIDs) {
		return 0, errors.New("one or more editions do not exist")
	}
	if _, err := tx.Exec(ctx, `UPDATE editions SET
		language=CASE WHEN $1 THEN NULLIF(BTRIM($2),'') ELSE language END,
		publisher=CASE WHEN $3 THEN NULLIF(BTRIM($4),'') ELSE publisher END,
		published_year=CASE WHEN $5 THEN $6 ELSE published_year END,
		updated_at=now() WHERE id=ANY($7)`,
		patch.Language != nil, pointerString(patch.Language), patch.Publisher != nil, pointerString(patch.Publisher),
		patch.PublishedYear != nil, pointerInt(patch.PublishedYear), editionIDs); err != nil {
		return 0, fmt.Errorf("batch update editions: %w", err)
	}
	if patch.CategoryMode != "" {
		if patch.CategoryMode == "replace" {
			if _, err := tx.Exec(ctx, `UPDATE classification_decisions SET status='rejected',decided_by=$1,updated_at=now()
				WHERE edition_id=ANY($2) AND status IN ('accepted','suggested')`, userID, editionIDs); err != nil {
				return 0, err
			}
		}
		for _, slug := range uniqueStrings(patch.CategorySlugs) {
			command, err := tx.Exec(ctx, `INSERT INTO classification_decisions(edition_id,category_id,source,confidence,reason,status,decided_by)
				SELECT edition_id,c.id,'manual-batch',1,'管理员批量确认','accepted',$1
				FROM unnest($2::bigint[]) AS selected(edition_id) CROSS JOIN categories c WHERE c.slug=$3 AND c.active=true
				ON CONFLICT (edition_id,category_id,source) DO UPDATE SET status='accepted',decided_by=$1,updated_at=now()`, userID, editionIDs, slug)
			if err != nil {
				return 0, err
			}
			if command.RowsAffected() != int64(len(editionIDs)) {
				return 0, fmt.Errorf("unknown category %q", slug)
			}
		}
		if len(patch.CategorySlugs) > 0 {
			if _, err := tx.Exec(ctx, `UPDATE works SET review_status='reviewed',updated_at=now()
				WHERE id IN (SELECT work_id FROM editions WHERE id=ANY($1))`, editionIDs); err != nil {
				return 0, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(editionIDs), nil
}

func (s *Store) MergeWorks(ctx context.Context, sourceWorkID, targetWorkID int64) error {
	if sourceWorkID <= 0 || targetWorkID <= 0 || sourceWorkID == targetWorkID {
		return errors.New("source and target works must be different positive IDs")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, "SELECT id FROM works WHERE id=ANY($1) FOR UPDATE", []int64{sourceWorkID, targetWorkID})
	if err != nil {
		return err
	}
	count := 0
	for rows.Next() {
		count++
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if count != 2 {
		return errors.New("source or target work does not exist")
	}
	if _, err := tx.Exec(ctx, "UPDATE editions SET work_id=$1,updated_at=now() WHERE work_id=$2", targetWorkID, sourceWorkID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM works WHERE id=$1", sourceWorkID); err != nil {
		return err
	}
	_, _ = tx.Exec(ctx, "UPDATE works SET updated_at=now() WHERE id=$1", targetWorkID)
	return tx.Commit(ctx)
}

func (s *Store) MergeEditions(ctx context.Context, sourceEditionID, targetEditionID int64) error {
	if sourceEditionID <= 0 || targetEditionID <= 0 || sourceEditionID == targetEditionID {
		return errors.New("source and target editions must be different positive IDs")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var sourceWorkID, targetWorkID int64
	if err := tx.QueryRow(ctx, "SELECT work_id FROM editions WHERE id=$1 FOR UPDATE", sourceEditionID).Scan(&sourceWorkID); err != nil {
		return fmt.Errorf("source edition: %w", err)
	}
	if err := tx.QueryRow(ctx, "SELECT work_id FROM editions WHERE id=$1 FOR UPDATE", targetEditionID).Scan(&targetWorkID); err != nil {
		return fmt.Errorf("target edition: %w", err)
	}
	if _, err := tx.Exec(ctx, "UPDATE book_files SET edition_id=$1 WHERE edition_id=$2", targetEditionID, sourceEditionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO edition_creators(edition_id,creator_id,role,position)
		SELECT $1,creator_id,role,position FROM edition_creators WHERE edition_id=$2
		ON CONFLICT (edition_id,creator_id,role) DO UPDATE SET position=LEAST(edition_creators.position,EXCLUDED.position)`, targetEditionID, sourceEditionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO classification_decisions(edition_id,category_id,source,confidence,reason,status,decided_by)
		SELECT $1,category_id,source,confidence,reason,status,decided_by FROM classification_decisions WHERE edition_id=$2
		ON CONFLICT (edition_id,category_id,source) DO UPDATE SET
			confidence=GREATEST(classification_decisions.confidence,EXCLUDED.confidence),
			status=CASE WHEN classification_decisions.status='accepted' OR EXCLUDED.status='accepted' THEN 'accepted' ELSE classification_decisions.status END,
			updated_at=now()`, targetEditionID, sourceEditionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "UPDATE metadata_candidates SET edition_id=$1 WHERE edition_id=$2", targetEditionID, sourceEditionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM editions WHERE id=$1", sourceEditionID); err != nil {
		return err
	}
	if sourceWorkID != targetWorkID {
		_, _ = tx.Exec(ctx, "DELETE FROM works WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM editions WHERE work_id=$1)", sourceWorkID)
	}
	_, _ = tx.Exec(ctx, "UPDATE editions SET updated_at=now() WHERE id=$1", targetEditionID)
	return tx.Commit(ctx)
}

func (s *Store) ListDuplicateCatalogGroups(ctx context.Context) ([]DuplicateCatalogGroup, error) {
	rows, err := s.pool.Query(ctx, `WITH edition_items AS (
		SELECT e.id edition_id,w.id work_id,w.title,COALESCE(e.isbn,'') isbn,
			(SELECT bf.id FROM book_files bf WHERE bf.edition_id=e.id ORDER BY bf.id LIMIT 1) book_file_id,
			(SELECT bf.format FROM book_files bf WHERE bf.edition_id=e.id ORDER BY bf.id LIMIT 1) format,
			(SELECT bf.original_filename FROM book_files bf WHERE bf.edition_id=e.id ORDER BY bf.id LIMIT 1) original_filename
		FROM editions e JOIN works w ON w.id=e.work_id WHERE EXISTS(SELECT 1 FROM book_files bf WHERE bf.edition_id=e.id)
	), groups AS (
		SELECT 'title' kind,lower(regexp_replace(btrim(title),'\\s+',' ','g')) key,
			jsonb_agg(jsonb_build_object('workId',work_id,'editionId',edition_id,'bookFileId',book_file_id,'title',title,'isbn',isbn,'format',format,'originalFilename',original_filename) ORDER BY edition_id) items
		FROM edition_items GROUP BY lower(regexp_replace(btrim(title),'\\s+',' ','g')) HAVING count(DISTINCT work_id)>1
		UNION ALL
		SELECT 'isbn',isbn,jsonb_agg(jsonb_build_object('workId',work_id,'editionId',edition_id,'bookFileId',book_file_id,'title',title,'isbn',isbn,'format',format,'originalFilename',original_filename) ORDER BY edition_id)
		FROM edition_items WHERE isbn<>'' GROUP BY isbn HAVING count(*)>1
	)
	SELECT kind,key,items FROM groups ORDER BY kind,key LIMIT 100`)
	if err != nil {
		return nil, fmt.Errorf("list duplicate catalog groups: %w", err)
	}
	defer rows.Close()
	groups := make([]DuplicateCatalogGroup, 0)
	for rows.Next() {
		var group DuplicateCatalogGroup
		var encoded []byte
		if err := rows.Scan(&group.Kind, &group.Key, &encoded); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(encoded, &group.Items); err != nil {
			return nil, err
		}
		groups = append(groups, group)
	}
	return groups, rows.Err()
}

func pointerString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func pointerInt(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}
