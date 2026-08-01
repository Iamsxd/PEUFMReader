package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"peufmreader/internal/classification"
	"peufmreader/internal/metadata"
)

// CalibreReference identifies a file in a read-only Calibre library. The
// application stores this locator and its catalogue record, never the ebook
// bytes themselves.
type CalibreReference struct {
	ReferenceKey     string
	ReferencePath    string
	OriginalFilename string
	Format           string
	MIMEType         string
	SizeBytes        int64
}

// RegisterCalibreReference creates a catalogue entry for a Calibre book while
// deliberately keeping its ebook file outside the managed library. Existing
// records retain curator-edited metadata and only refresh the source locator.
func (s *Store) RegisterCalibreReference(
	ctx context.Context,
	reference CalibreReference,
	extracted metadata.Result,
	suggestions []classification.Suggestion,
	coverPath string,
) (BookFile, bool, error) {
	reference.ReferenceKey = strings.TrimSpace(reference.ReferenceKey)
	reference.ReferencePath = strings.TrimSpace(reference.ReferencePath)
	reference.OriginalFilename = strings.TrimSpace(reference.OriginalFilename)
	reference.Format = strings.ToLower(strings.TrimSpace(reference.Format))
	reference.MIMEType = strings.TrimSpace(reference.MIMEType)
	if reference.ReferenceKey == "" || reference.ReferencePath == "" || reference.OriginalFilename == "" || reference.MIMEType == "" || reference.SizeBytes < 0 {
		return BookFile{}, false, errors.New("Calibre reference is incomplete")
	}
	if reference.Format != "pdf" && reference.Format != "epub" && reference.Format != "mobi" && reference.Format != "azw3" {
		return BookFile{}, false, errors.New("Calibre reference format is unsupported")
	}

	existing, found, err := s.getCatalogBookByReferenceKey(ctx, reference.ReferenceKey)
	if err != nil {
		return BookFile{}, false, err
	}
	if found {
		_, err := s.pool.Exec(ctx, `
			UPDATE book_files SET reference_path=$1,original_filename=$2,format=$3,mime_type=$4,size_bytes=$5
			WHERE id=$6 AND storage_mode='calibre-reference'`,
			reference.ReferencePath, reference.OriginalFilename, reference.Format, reference.MIMEType, reference.SizeBytes, existing.ID,
		)
		if err != nil {
			return BookFile{}, false, fmt.Errorf("refresh Calibre reference locator: %w", err)
		}
		refreshed, ok, err := s.GetCatalogBook(ctx, existing.ID)
		if err != nil || !ok {
			return BookFile{}, false, fmt.Errorf("load refreshed Calibre reference: %w", err)
		}
		return refreshed, false, nil
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
		return BookFile{}, false, fmt.Errorf("create referenced work: %w", err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO editions(work_id,isbn,language,published_year,publisher,source_subjects,metadata)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
		workID, nullIfEmpty(extracted.ISBN), nullIfEmpty(extracted.Language), extracted.PublishedYear,
		nullIfEmpty(extracted.Publisher), extracted.Subjects, map[string]any{"source": extracted.Source, "confidence": extracted.Confidence, "storageMode": "calibre-reference"},
	).Scan(&editionID); err != nil {
		return BookFile{}, false, fmt.Errorf("create referenced edition: %w", err)
	}
	fingerprint := sha256.Sum256([]byte("calibre-reference:v1\x00" + reference.ReferenceKey))
	storagePath := "calibre-reference/" + fmt.Sprintf("%x", fingerprint[:])
	if err := tx.QueryRow(ctx, `
		INSERT INTO book_files(edition_id,original_filename,storage_path,storage_mode,reference_path,reference_key,sha256,format,mime_type,size_bytes,cover_path)
		VALUES ($1,$2,$3,'calibre-reference',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
		editionID, reference.OriginalFilename, storagePath, reference.ReferencePath, reference.ReferenceKey, fingerprint[:], reference.Format, reference.MIMEType, reference.SizeBytes, nullIfEmpty(coverPath),
	).Scan(&bookFileID); err != nil {
		return BookFile{}, false, fmt.Errorf("create Calibre reference: %w", err)
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
			return BookFile{}, false, fmt.Errorf("save Calibre reference classification: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return BookFile{}, false, err
	}
	book, found, err := s.GetCatalogBook(ctx, bookFileID)
	if err != nil || !found {
		return BookFile{}, false, fmt.Errorf("load Calibre reference: %w", err)
	}
	return book, true, nil
}

func (s *Store) getCatalogBookByReferenceKey(ctx context.Context, referenceKey string) (BookFile, bool, error) {
	book, err := scanCatalogBook(s.pool.QueryRow(ctx, catalogBookSelect+" WHERE bf.reference_key=$1", referenceKey))
	if errors.Is(err, pgx.ErrNoRows) {
		return BookFile{}, false, nil
	}
	if err != nil {
		return BookFile{}, false, err
	}
	return book, true, nil
}
