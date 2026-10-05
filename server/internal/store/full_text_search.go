package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

const TextIndexVersion = 1

type SearchPassage struct {
	Label    string         `json:"label"`
	Position map[string]any `json:"position"`
	Body     string         `json:"-"`
}
type TextSearchHit struct {
	BookFileID int64          `json:"bookFileId"`
	BookTitle  string         `json:"bookTitle"`
	BookFormat string         `json:"bookFormat"`
	Label      string         `json:"label"`
	Position   map[string]any `json:"position"`
	Excerpt    string         `json:"excerpt"`
	Coverage   string         `json:"coverage"`
}
type TextSearchPage struct {
	Items   []TextSearchHit `json:"items"`
	Page    int             `json:"page"`
	HasMore bool            `json:"hasMore"`
}
type TextIndexStats struct {
	EligibleBooks int `json:"eligibleBooks"`
	IndexedBooks  int `json:"indexedBooks"`
	PassageCount  int `json:"passageCount"`
}

const currentTextDocument = `d.source_hash=bf.sha256 AND d.text_path=COALESCE(bf.extracted_text_path,'')
    AND d.text_method=COALESCE(bf.text_extraction_method,'') AND d.version=1`

func (s *Store) TextIndexCandidates(ctx context.Context, limit int) ([]BookFile, error) {
	limit = max(1, min(limit, 10000))
	rows, err := s.pool.Query(ctx, catalogBookSelect+` LEFT JOIN search_documents d ON d.book_file_id=bf.id
        WHERE (bf.format='epub' OR (bf.format='pdf' AND bf.extracted_text_path IS NOT NULL))
        AND (d.book_file_id IS NULL OR NOT (`+currentTextDocument+`)) ORDER BY bf.id LIMIT $1`, limit)
	if err != nil {
		return nil, err
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
func (s *Store) ReplaceTextIndex(ctx context.Context, book BookFile, coverage string, passages []SearchPassage) error {
	if len(passages) > 10000 {
		return errors.New("too many text passages")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var hash []byte
	var textPath, textMethod string
	err = tx.QueryRow(ctx, `SELECT sha256,COALESCE(extracted_text_path,''),COALESCE(text_extraction_method,'') FROM book_files WHERE id=$1 FOR UPDATE`, book.ID).Scan(&hash, &textPath, &textMethod)
	if err != nil {
		return err
	}
	if !bytes.Equal(hash, book.SHA256) || textPath != book.TextPath || textMethod != book.TextMethod {
		return errors.New("book changed while indexing; retry")
	}
	_, err = tx.Exec(ctx, `INSERT INTO search_documents(book_file_id,source_hash,text_path,text_method,version,coverage,passage_count)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(book_file_id) DO UPDATE SET source_hash=EXCLUDED.source_hash,
        text_path=EXCLUDED.text_path,text_method=EXCLUDED.text_method,version=EXCLUDED.version,
        coverage=EXCLUDED.coverage,passage_count=EXCLUDED.passage_count,indexed_at=now()`, book.ID, hash, textPath, textMethod, TextIndexVersion, coverage, len(passages))
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM search_passages WHERE book_file_id=$1`, book.ID); err != nil {
		return err
	}
	for index, p := range passages {
		if len([]rune(p.Body)) > 2000 || len(p.Body) == 0 || strings.ContainsRune(p.Body, 0) {
			return errors.New("invalid passage")
		}
		if _, err = tx.Exec(ctx, `INSERT INTO search_passages(book_file_id,ordinal,label,position,body) VALUES($1,$2,$3,$4,$5)`, book.ID, index, p.Label, p.Position, p.Body); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func (s *Store) TextIndexStatus(ctx context.Context, userID int64) (TextIndexStats, error) {
	var result TextIndexStats
	err := s.pool.QueryRow(ctx, `WITH allowed AS MATERIALIZED(SELECT book_file_id FROM accessible_book_ids($1))
        SELECT COUNT(*),COUNT(d.book_file_id) FILTER(WHERE `+currentTextDocument+`),
        COALESCE(SUM(d.passage_count) FILTER(WHERE `+currentTextDocument+`),0)
        FROM allowed a JOIN book_files bf ON bf.id=a.book_file_id LEFT JOIN search_documents d ON d.book_file_id=bf.id
        WHERE bf.format='epub' OR (bf.format='pdf' AND bf.extracted_text_path IS NOT NULL)`, userID).
		Scan(&result.EligibleBooks, &result.IndexedBooks, &result.PassageCount)
	return result, err
}
func textExcerpt(body, query string) string {
	// Rune offsets keep Chinese excerpts intact. Lowercase per rune retains
	// the offset even when UTF-8 byte lengths differ.
	runes := []rune(body)
	lower := []rune(strings.ToLower(body))
	needle := []rune(strings.ToLower(query))
	match := 0
	for i := 0; i+len(needle) <= len(lower); i++ {
		if string(lower[i:i+len(needle)]) == string(needle) {
			match = i
			break
		}
	}
	start := max(0, match-70)
	end := min(len(runes), match+len(needle)+140)
	excerpt := string(runes[start:end])
	if start > 0 {
		excerpt = "…" + excerpt
	}
	if end < len(runes) {
		excerpt += "…"
	}
	return excerpt
}
func (s *Store) SearchText(ctx context.Context, userID int64, query string, page int) (TextSearchPage, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	page = max(1, min(page, 50))
	result := TextSearchPage{Items: make([]TextSearchHit, 0), Page: page}
	rows, err := s.pool.Query(ctx, `WITH allowed AS MATERIALIZED(SELECT book_file_id FROM accessible_book_ids($1))
        SELECT bf.id,w.title,bf.format,p.label,p.position,p.body,d.coverage FROM allowed a
        JOIN book_files bf ON bf.id=a.book_file_id JOIN editions e ON e.id=bf.edition_id JOIN works w ON w.id=e.work_id
        JOIN search_documents d ON d.book_file_id=bf.id JOIN search_passages p ON p.book_file_id=bf.id
        WHERE `+currentTextDocument+` AND lower(p.body) LIKE lower('%'||$2||'%') ESCAPE E'\\'
        ORDER BY w.sort_title,bf.id,p.ordinal LIMIT 25 OFFSET $3`, userID, escapeLikePattern(query), (page-1)*24)
	if err != nil {
		return result, fmt.Errorf("search text: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var hit TextSearchHit
		var body string
		if err = rows.Scan(&hit.BookFileID, &hit.BookTitle, &hit.BookFormat, &hit.Label, &hit.Position, &body, &hit.Coverage); err != nil {
			return result, err
		}
		hit.Excerpt = textExcerpt(body, query)
		result.Items = append(result.Items, hit)
	}
	if len(result.Items) > 24 {
		result.Items = result.Items[:24]
		result.HasMore = page < 50
	}
	return result, rows.Err()
}
