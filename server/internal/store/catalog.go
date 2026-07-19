package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"peufmreader/internal/bibliography"
	"peufmreader/internal/classification"
	"peufmreader/internal/library"
	"peufmreader/internal/metadata"
)

type Category struct {
	ID   int64  `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type MetadataCandidate struct {
	ID         int64           `json:"id"`
	FieldName  string          `json:"fieldName"`
	Value      json.RawMessage `json:"value"`
	Source     string          `json:"source"`
	Confidence float64         `json:"confidence"`
	Reason     string          `json:"reason"`
	Status     string          `json:"status"`
}

type ClassificationDecision struct {
	ID         int64   `json:"id"`
	CategoryID int64   `json:"categoryId"`
	Slug       string  `json:"categorySlug"`
	Name       string  `json:"categoryName"`
	Source     string  `json:"source"`
	Confidence float64 `json:"confidence"`
	Reason     string  `json:"reason"`
	Status     string  `json:"status"`
}

type ReviewItem struct {
	EditionID       int64                    `json:"editionId"`
	WorkID          int64                    `json:"workId"`
	BookFileID      int64                    `json:"bookFileId"`
	Title           string                   `json:"title"`
	Authors         []string                 `json:"authors"`
	PublishedYear   *int                     `json:"publishedYear,omitempty"`
	Language        string                   `json:"language,omitempty"`
	ISBN            string                   `json:"isbn,omitempty"`
	Publisher       string                   `json:"publisher,omitempty"`
	Description     string                   `json:"description,omitempty"`
	SourceSubjects  []string                 `json:"sourceSubjects"`
	Candidates      []MetadataCandidate      `json:"candidates"`
	Classifications []ClassificationDecision `json:"classifications"`
}

type ReviewInput struct {
	Title         string
	Authors       []string
	PublishedYear *int
	Language      string
	ISBN          string
	Publisher     string
	Description   string
	CategorySlugs []string
}

type ImportJob struct {
	ID           int64           `json:"id"`
	State        string          `json:"state"`
	SourceName   string          `json:"sourceName"`
	ErrorMessage string          `json:"errorMessage,omitempty"`
	BookFileID   *int64          `json:"bookFileId,omitempty"`
	Warnings     json.RawMessage `json:"warnings"`
	CreatedAt    time.Time       `json:"createdAt"`
	UpdatedAt    time.Time       `json:"updatedAt"`
}

const catalogBookSelect = `
	SELECT bf.id,w.id,e.id,w.title,bf.original_filename,bf.storage_path,bf.sha256,bf.format,bf.mime_type,bf.size_bytes,bf.created_at,
		e.published_year,COALESCE(e.language,''),COALESCE(e.isbn,''),COALESCE(e.publisher,''),COALESCE(bf.cover_path,''),
		COALESCE(bf.extracted_text_path,''),COALESCE(bf.text_extraction_method,''),bf.page_count,
		COALESCE((SELECT jsonb_agg(c.name ORDER BY ec.position,c.id)
			FROM edition_creators ec JOIN creators c ON c.id=ec.creator_id
			WHERE ec.edition_id=e.id AND ec.role='author'),'[]'::jsonb),
		COALESCE((SELECT jsonb_agg(jsonb_build_object('id',cat.id,'slug',cat.slug,'name',cat.name) ORDER BY cat.name)
			FROM classification_decisions cd JOIN categories cat ON cat.id=cd.category_id
			WHERE cd.edition_id=e.id AND cd.status='accepted'),'[]'::jsonb),
		(w.review_status='pending' OR EXISTS(
			SELECT 1 FROM classification_decisions pending_cd WHERE pending_cd.edition_id=e.id AND pending_cd.status='suggested'))
	` + catalogBookFrom

const catalogBookFrom = `
	FROM book_files bf
	JOIN editions e ON e.id=bf.edition_id
	JOIN works w ON w.id=e.work_id`

type scanner interface {
	Scan(dest ...any) error
}

func scanCatalogBook(row scanner) (BookFile, error) {
	var book BookFile
	var authorsJSON, categoriesJSON []byte
	err := row.Scan(
		&book.ID, &book.WorkID, &book.EditionID, &book.Title, &book.OriginalFilename, &book.StoragePath, &book.SHA256,
		&book.Format, &book.MIMEType, &book.SizeBytes, &book.CreatedAt, &book.PublishedYear, &book.Language,
		&book.ISBN, &book.Publisher, &book.CoverPath, &book.TextPath, &book.TextMethod, &book.PageCount,
		&authorsJSON, &categoriesJSON, &book.ReviewRequired,
	)
	if err != nil {
		return BookFile{}, err
	}
	if err := json.Unmarshal(authorsJSON, &book.Authors); err != nil {
		return BookFile{}, err
	}
	if err := json.Unmarshal(categoriesJSON, &book.Categories); err != nil {
		return BookFile{}, err
	}
	if book.Authors == nil {
		book.Authors = []string{}
	}
	if book.Categories == nil {
		book.Categories = []Category{}
	}
	book.TextAvailable = book.TextPath != ""
	return book, nil
}

func (s *Store) CreateImportJob(ctx context.Context, userID int64, sourceName string) (ImportJob, error) {
	var job ImportJob
	err := s.pool.QueryRow(ctx, `
		INSERT INTO import_jobs(state,source_name,created_by) VALUES ('running',$1,$2)
		RETURNING id,state,source_name,COALESCE(error_message,''),book_file_id,warnings,created_at,updated_at`,
		strings.TrimSpace(sourceName), userID,
	).Scan(&job.ID, &job.State, &job.SourceName, &job.ErrorMessage, &job.BookFileID, &job.Warnings, &job.CreatedAt, &job.UpdatedAt)
	return job, err
}

func (s *Store) FailImportJob(ctx context.Context, jobID int64, failure error) error {
	message := failure.Error()
	if len(message) > 2000 {
		message = message[:2000]
	}
	_, err := s.pool.Exec(ctx, "UPDATE import_jobs SET state='failed',error_message=$1,updated_at=now() WHERE id=$2", message, jobID)
	return err
}

func (s *Store) CompleteImportJob(ctx context.Context, jobID, bookFileID int64, warnings []string) error {
	encodedWarnings, _ := json.Marshal(warnings)
	_, err := s.pool.Exec(ctx, `
		UPDATE import_jobs SET state='completed',book_file_id=$1,warnings=$2,error_message=NULL,updated_at=now() WHERE id=$3`,
		bookFileID, encodedWarnings, jobID)
	return err
}

func (s *Store) AppendImportJobWarning(ctx context.Context, jobID int64, warning string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE import_jobs SET warnings=warnings || jsonb_build_array($1::text),updated_at=now() WHERE id=$2`, warning, jobID)
	return err
}

func (s *Store) ListImportJobs(ctx context.Context, limit int) ([]ImportJob, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id,state,source_name,COALESCE(error_message,''),book_file_id,warnings,created_at,updated_at
		FROM import_jobs ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ImportJob, 0)
	for rows.Next() {
		var job ImportJob
		if err := rows.Scan(&job.ID, &job.State, &job.SourceName, &job.ErrorMessage, &job.BookFileID, &job.Warnings, &job.CreatedAt, &job.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, job)
	}
	return result, rows.Err()
}

func (s *Store) RegisterImportedBook(ctx context.Context, stored library.StoredFile, extracted metadata.Result, suggestions []classification.Suggestion, coverPath string, createdBy, jobID int64) (BookFile, bool, error) {
	existing, found, err := s.getCatalogBookByHash(ctx, stored.SHA256)
	if err != nil {
		return BookFile{}, false, err
	}
	if found {
		if err := s.CompleteImportJob(ctx, jobID, existing.ID, append(extracted.Warnings, "检测到重复文件，沿用已有书籍记录")); err != nil {
			return BookFile{}, false, err
		}
		return existing, true, nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BookFile{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	hasAcceptedCategory := false
	for _, suggestion := range suggestions {
		if suggestion.Status == "accepted" {
			hasAcceptedCategory = true
		}
	}
	reviewStatus := "pending"
	if extracted.Confidence >= 0.8 && len(extracted.Authors) > 0 && hasAcceptedCategory {
		reviewStatus = "reviewed"
	}
	var workID, editionID, bookFileID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO works(title,sort_title,description,review_status) VALUES ($1,$2,$3,$4) RETURNING id`,
		extracted.Title, strings.ToLower(extracted.Title), nullIfEmpty(extracted.Description), reviewStatus,
	).Scan(&workID); err != nil {
		return BookFile{}, false, fmt.Errorf("create work: %w", err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO editions(work_id,isbn,language,published_year,publisher,source_subjects,metadata)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
		workID, nullIfEmpty(extracted.ISBN), nullIfEmpty(extracted.Language), extracted.PublishedYear,
		nullIfEmpty(extracted.Publisher), extracted.Subjects, map[string]any{"source": extracted.Source, "confidence": extracted.Confidence},
	).Scan(&editionID); err != nil {
		return BookFile{}, false, fmt.Errorf("create edition: %w", err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO book_files(edition_id,original_filename,storage_path,sha256,format,mime_type,size_bytes,cover_path)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		editionID, stored.OriginalFilename, stored.RelativePath, stored.SHA256, stored.Format, stored.MIMEType, stored.SizeBytes, nullIfEmpty(coverPath),
	).Scan(&bookFileID); err != nil {
		return BookFile{}, false, fmt.Errorf("create book file: %w", err)
	}
	if err := replaceAuthors(ctx, tx, editionID, extracted.Authors); err != nil {
		return BookFile{}, false, err
	}
	if err := insertExtractedCandidates(ctx, tx, editionID, extracted); err != nil {
		return BookFile{}, false, err
	}
	for _, suggestion := range suggestions {
		if _, err := tx.Exec(ctx, `
			INSERT INTO classification_decisions(edition_id,category_id,source,confidence,reason,status)
			SELECT $1,id,$2,$3,$4,$5 FROM categories WHERE slug=$6 AND active=true
			ON CONFLICT (edition_id,category_id,source) DO UPDATE SET
				confidence=EXCLUDED.confidence,reason=EXCLUDED.reason,status=EXCLUDED.status,updated_at=now()`,
			editionID, suggestion.Source, suggestion.Confidence, suggestion.Reason, suggestion.Status, suggestion.CategorySlug,
		); err != nil {
			return BookFile{}, false, fmt.Errorf("save classification suggestion: %w", err)
		}
	}
	encodedWarnings, _ := json.Marshal(extracted.Warnings)
	if _, err := tx.Exec(ctx, `
		UPDATE import_jobs SET state='completed',book_file_id=$1,warnings=$2,error_message=NULL,updated_at=now() WHERE id=$3`,
		bookFileID, encodedWarnings, jobID); err != nil {
		return BookFile{}, false, fmt.Errorf("complete import job: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return BookFile{}, false, err
	}
	book, found, err := s.GetCatalogBook(ctx, bookFileID)
	if err != nil || !found {
		return BookFile{}, false, fmt.Errorf("load imported book: %w", err)
	}
	_ = createdBy // Reserved for the import audit actor; import_jobs already records it.
	return book, false, nil
}

func (s *Store) ListCatalogBooks(ctx context.Context) ([]BookFile, error) {
	rows, err := s.pool.Query(ctx, catalogBookSelect+" ORDER BY w.sort_title,bf.id")
	if err != nil {
		return nil, fmt.Errorf("list catalog books: %w", err)
	}
	defer rows.Close()
	books := make([]BookFile, 0)
	for rows.Next() {
		book, err := scanCatalogBook(rows)
		if err != nil {
			return nil, err
		}
		books = append(books, book)
	}
	return books, rows.Err()
}

func (s *Store) GetCatalogBook(ctx context.Context, bookFileID int64) (BookFile, bool, error) {
	book, err := scanCatalogBook(s.pool.QueryRow(ctx, catalogBookSelect+" WHERE bf.id=$1", bookFileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return BookFile{}, false, nil
	}
	return book, err == nil, err
}

func (s *Store) getCatalogBookByHash(ctx context.Context, hash []byte) (BookFile, bool, error) {
	book, err := scanCatalogBook(s.pool.QueryRow(ctx, catalogBookSelect+" WHERE bf.sha256=$1", hash))
	if errors.Is(err, pgx.ErrNoRows) {
		return BookFile{}, false, nil
	}
	return book, err == nil, err
}

func (s *Store) ListCategories(ctx context.Context) ([]Category, error) {
	rows, err := s.pool.Query(ctx, "SELECT id,slug,name FROM categories WHERE active=true ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	categories := make([]Category, 0)
	for rows.Next() {
		var category Category
		if err := rows.Scan(&category.ID, &category.Slug, &category.Name); err != nil {
			return nil, err
		}
		categories = append(categories, category)
	}
	return categories, rows.Err()
}

func (s *Store) ListReviewQueue(ctx context.Context) ([]ReviewItem, error) {
	rows, err := s.pool.Query(ctx, reviewItemSelect+`
		WHERE w.review_status='pending' OR EXISTS(
			SELECT 1 FROM classification_decisions pending_cd WHERE pending_cd.edition_id=e.id AND pending_cd.status='suggested')
		ORDER BY w.updated_at,e.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]ReviewItem, 0)
	for rows.Next() {
		item, err := scanReviewItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

const reviewItemSelect = `
	SELECT e.id,w.id,(SELECT bf.id FROM book_files bf WHERE bf.edition_id=e.id ORDER BY bf.id LIMIT 1),
		w.title,COALESCE(w.description,''),e.published_year,COALESCE(e.language,''),COALESCE(e.isbn,''),COALESCE(e.publisher,''),e.source_subjects,
		COALESCE((SELECT jsonb_agg(c.name ORDER BY ec.position,c.id)
			FROM edition_creators ec JOIN creators c ON c.id=ec.creator_id
			WHERE ec.edition_id=e.id AND ec.role='author'),'[]'::jsonb),
		COALESCE((SELECT jsonb_agg(jsonb_build_object(
			'id',mc.id,'fieldName',mc.field_name,'value',mc.value,'source',mc.source,'confidence',mc.confidence,'reason',mc.reason,'status',mc.status)
			ORDER BY mc.id) FROM metadata_candidates mc WHERE mc.edition_id=e.id),'[]'::jsonb),
		COALESCE((SELECT jsonb_agg(jsonb_build_object(
			'id',cd.id,'categoryId',cat.id,'categorySlug',cat.slug,'categoryName',cat.name,'source',cd.source,
			'confidence',cd.confidence,'reason',cd.reason,'status',cd.status) ORDER BY cd.confidence DESC,cd.id)
			FROM classification_decisions cd JOIN categories cat ON cat.id=cd.category_id
			WHERE cd.edition_id=e.id),'[]'::jsonb)
	FROM editions e JOIN works w ON w.id=e.work_id`

func scanReviewItem(row scanner) (ReviewItem, error) {
	var item ReviewItem
	var authorsJSON, candidatesJSON, classificationsJSON []byte
	err := row.Scan(&item.EditionID, &item.WorkID, &item.BookFileID, &item.Title, &item.Description,
		&item.PublishedYear, &item.Language, &item.ISBN, &item.Publisher, &item.SourceSubjects,
		&authorsJSON, &candidatesJSON, &classificationsJSON)
	if err != nil {
		return ReviewItem{}, err
	}
	if err := json.Unmarshal(authorsJSON, &item.Authors); err != nil {
		return ReviewItem{}, err
	}
	if err := json.Unmarshal(candidatesJSON, &item.Candidates); err != nil {
		return ReviewItem{}, err
	}
	if err := json.Unmarshal(classificationsJSON, &item.Classifications); err != nil {
		return ReviewItem{}, err
	}
	return item, nil
}

func (s *Store) GetReviewItem(ctx context.Context, editionID int64) (ReviewItem, bool, error) {
	item, err := scanReviewItem(s.pool.QueryRow(ctx, reviewItemSelect+" WHERE e.id=$1", editionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ReviewItem{}, false, nil
	}
	return item, err == nil, err
}

func (s *Store) ReviewEdition(ctx context.Context, editionID, userID int64, input ReviewInput) (ReviewItem, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReviewItem{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var workID int64
	if err := tx.QueryRow(ctx, "SELECT work_id FROM editions WHERE id=$1 FOR UPDATE", editionID).Scan(&workID); err != nil {
		return ReviewItem{}, err
	}
	status := "reviewed"
	if len(input.CategorySlugs) == 0 {
		status = "pending"
	}
	if _, err := tx.Exec(ctx, "UPDATE works SET title=$1,sort_title=$2,description=$3,review_status=$4,updated_at=now() WHERE id=$5",
		input.Title, strings.ToLower(input.Title), nullIfEmpty(input.Description), status, workID); err != nil {
		return ReviewItem{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE editions SET isbn=$1,language=$2,published_year=$3,publisher=$4,updated_at=now() WHERE id=$5`,
		nullIfEmpty(input.ISBN), nullIfEmpty(input.Language), input.PublishedYear, nullIfEmpty(input.Publisher), editionID); err != nil {
		return ReviewItem{}, err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM edition_creators WHERE edition_id=$1 AND role='author'", editionID); err != nil {
		return ReviewItem{}, err
	}
	if err := replaceAuthors(ctx, tx, editionID, input.Authors); err != nil {
		return ReviewItem{}, err
	}
	if _, err := tx.Exec(ctx, "UPDATE metadata_candidates SET status='superseded',updated_at=now() WHERE edition_id=$1 AND status='accepted'", editionID); err != nil {
		return ReviewItem{}, err
	}
	manual := metadata.Result{Title: input.Title, Authors: input.Authors, PublishedYear: input.PublishedYear, Language: input.Language, ISBN: input.ISBN, Publisher: input.Publisher, Description: input.Description, Source: "manual", Confidence: 1}
	if err := insertExtractedCandidates(ctx, tx, editionID, manual); err != nil {
		return ReviewItem{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE classification_decisions SET status='rejected',decided_by=$1,updated_at=now()
		WHERE edition_id=$2 AND status IN ('suggested','accepted')`, userID, editionID); err != nil {
		return ReviewItem{}, err
	}
	for _, slug := range uniqueStrings(input.CategorySlugs) {
		command, err := tx.Exec(ctx, `
			INSERT INTO classification_decisions(edition_id,category_id,source,confidence,reason,status,decided_by)
			SELECT $1,id,'manual',1,'管理员确认','accepted',$2 FROM categories WHERE slug=$3 AND active=true
			ON CONFLICT (edition_id,category_id,source) DO UPDATE SET
				confidence=1,reason='管理员确认',status='accepted',decided_by=$2,updated_at=now()`, editionID, userID, slug)
		if err != nil {
			return ReviewItem{}, err
		}
		if command.RowsAffected() == 0 {
			return ReviewItem{}, fmt.Errorf("unknown category %q", slug)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ReviewItem{}, err
	}
	item, found, err := s.GetReviewItem(ctx, editionID)
	if err != nil || !found {
		return ReviewItem{}, fmt.Errorf("load reviewed edition: %w", err)
	}
	return item, nil
}

func (s *Store) EditionMetadata(ctx context.Context, editionID int64) (metadata.Result, bool, error) {
	item, found, err := s.GetReviewItem(ctx, editionID)
	if err != nil || !found {
		return metadata.Result{}, found, err
	}
	return metadata.Result{
		Title: item.Title, Authors: item.Authors, PublishedYear: item.PublishedYear, Language: item.Language,
		ISBN: item.ISBN, Publisher: item.Publisher, Description: item.Description, Subjects: item.SourceSubjects,
		Source: "catalog", Confidence: 1,
	}, true, nil
}

func (s *Store) AddClassificationSuggestions(ctx context.Context, editionID int64, suggestions []classification.Suggestion) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var workID int64
	if err := tx.QueryRow(ctx, "SELECT work_id FROM editions WHERE id=$1", editionID).Scan(&workID); err != nil {
		return err
	}
	for _, suggestion := range suggestions {
		command, err := tx.Exec(ctx, `
			INSERT INTO classification_decisions(edition_id,category_id,source,confidence,reason,status)
			SELECT $1,id,$2,$3,$4,'suggested' FROM categories WHERE slug=$5 AND active=true
			ON CONFLICT (edition_id,category_id,source) DO UPDATE SET
				confidence=EXCLUDED.confidence,reason=EXCLUDED.reason,status='suggested',decided_by=NULL,updated_at=now()`,
			editionID, suggestion.Source, suggestion.Confidence, suggestion.Reason, suggestion.CategorySlug)
		if err != nil {
			return err
		}
		if command.RowsAffected() == 0 {
			return fmt.Errorf("unknown category %q", suggestion.CategorySlug)
		}
	}
	if _, err := tx.Exec(ctx, "UPDATE works SET review_status='pending',updated_at=now() WHERE id=$1", workID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) AddBibliographySuggestions(ctx context.Context, editionID int64, matches []bibliography.Match) error {
	if len(matches) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var workID int64
	if err := tx.QueryRow(ctx, "SELECT work_id FROM editions WHERE id=$1", editionID).Scan(&workID); err != nil {
		return err
	}
	for _, match := range matches {
		source := match.Source + ":" + match.SourceID
		if _, err := tx.Exec(ctx, `DELETE FROM metadata_candidates WHERE edition_id=$1 AND source=$2 AND status='suggested'`, editionID, source); err != nil {
			return err
		}
		values := []struct {
			field string
			value any
		}{
			{"title", match.Title}, {"authors", match.Authors}, {"publishedYear", match.PublishedYear},
			{"language", match.Language}, {"isbn", match.ISBN}, {"publisher", match.Publisher},
			{"description", match.Description}, {"subjects", match.Subjects},
		}
		for _, candidate := range values {
			if isEmptyCandidate(candidate.value) {
				continue
			}
			encoded, marshalErr := json.Marshal(candidate.value)
			if marshalErr != nil {
				return marshalErr
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO metadata_candidates(edition_id,field_name,value,source,confidence,reason,status)
				VALUES ($1,$2,$3,$4,$5,$6,'suggested')`,
				editionID, candidate.field, encoded, source, match.Confidence, match.Reason); err != nil {
				return fmt.Errorf("save external metadata candidate: %w", err)
			}
		}
	}
	if _, err := tx.Exec(ctx, "UPDATE works SET review_status='pending',updated_at=now() WHERE id=$1", workID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func replaceAuthors(ctx context.Context, tx pgx.Tx, editionID int64, authors []string) error {
	for position, authorName := range uniqueStrings(authors) {
		authorName = strings.TrimSpace(authorName)
		if authorName == "" {
			continue
		}
		normalized := strings.ToLower(strings.Join(strings.Fields(authorName), " "))
		var creatorID int64
		if err := tx.QueryRow(ctx, `
			INSERT INTO creators(name,sort_name,normalized_name) VALUES ($1,$2,$3)
			ON CONFLICT (normalized_name) DO UPDATE SET name=EXCLUDED.name
			RETURNING id`, authorName, strings.ToLower(authorName), normalized).Scan(&creatorID); err != nil {
			return fmt.Errorf("save creator: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO edition_creators(edition_id,creator_id,role,position) VALUES ($1,$2,'author',$3)
			ON CONFLICT (edition_id,creator_id,role) DO UPDATE SET position=EXCLUDED.position`, editionID, creatorID, position); err != nil {
			return fmt.Errorf("link creator: %w", err)
		}
	}
	return nil
}

func insertExtractedCandidates(ctx context.Context, tx pgx.Tx, editionID int64, extracted metadata.Result) error {
	reason := "从 " + extracted.Source + " 提取"
	values := []struct {
		field string
		value any
	}{
		{"title", extracted.Title}, {"authors", extracted.Authors}, {"publishedYear", extracted.PublishedYear},
		{"language", extracted.Language}, {"isbn", extracted.ISBN}, {"publisher", extracted.Publisher},
		{"description", extracted.Description}, {"subjects", extracted.Subjects},
	}
	for _, candidate := range values {
		if isEmptyCandidate(candidate.value) {
			continue
		}
		encoded, err := json.Marshal(candidate.value)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO metadata_candidates(edition_id,field_name,value,source,confidence,reason,status)
			VALUES ($1,$2,$3,$4,$5,$6,'accepted')`, editionID, candidate.field, encoded, extracted.Source, extracted.Confidence, reason); err != nil {
			return fmt.Errorf("save metadata candidate: %w", err)
		}
	}
	return nil
}

func isEmptyCandidate(value any) bool {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed) == ""
	case []string:
		return len(typed) == 0
	case *int:
		return typed == nil
	default:
		return value == nil
	}
}

func nullIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool)
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		key := strings.ToLower(value)
		if value == "" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, value)
	}
	return result
}
