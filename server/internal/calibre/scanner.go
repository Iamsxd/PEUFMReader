package calibre

import (
	"context"
	"database/sql"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"peufmreader/internal/library"
	"peufmreader/internal/metadata"

	_ "modernc.org/sqlite"
)

const maxOPFBytes = 4 << 20

type Scanner struct {
	root string
}

type Record struct {
	SourcePath     string   `json:"sourcePath"`
	MetadataPath   string   `json:"metadataPath"`
	ReferenceKey   string   `json:"referenceKey,omitempty"`
	CoverPath      string   `json:"coverPath,omitempty"`
	Title          string   `json:"title"`
	Authors        []string `json:"authors"`
	PublishedYear  *int     `json:"publishedYear,omitempty"`
	Language       string   `json:"language,omitempty"`
	ISBN           string   `json:"isbn,omitempty"`
	Publisher      string   `json:"publisher,omitempty"`
	Description    string   `json:"description,omitempty"`
	Subjects       []string `json:"subjects"`
	OriginalFormat string   `json:"format"`
	SizeBytes      int64    `json:"sizeBytes,omitempty"`
}

type Preview struct {
	Configured bool     `json:"configured"`
	RootLabel  string   `json:"rootLabel"`
	Books      []Record `json:"books"`
	Total      int      `json:"total"`
	PDFCount   int      `json:"pdfCount"`
	EPUBCount  int      `json:"epubCount"`
	MOBICount  int      `json:"mobiCount"`
	AZW3Count  int      `json:"azw3Count"`
	Errors     []string `json:"errors"`
}

type packageDocument struct {
	Metadata struct {
		Titles       []string `xml:"title"`
		Creators     []string `xml:"creator"`
		Languages    []string `xml:"language"`
		Dates        []string `xml:"date"`
		Publishers   []string `xml:"publisher"`
		Descriptions []string `xml:"description"`
		Subjects     []string `xml:"subject"`
		Identifiers  []struct {
			Value  string `xml:",chardata"`
			Scheme string `xml:"scheme,attr"`
		} `xml:"identifier"`
	} `xml:"metadata"`
}

func NewScanner(root string) *Scanner {
	return &Scanner{root: filepath.Clean(strings.TrimSpace(root))}
}

// Configured reports whether the configured Calibre root is currently mounted
// and readable as a directory. It performs no scan and does not modify it.
func (s *Scanner) Configured() bool {
	if s.root == "" || s.root == "." {
		return false
	}
	root, err := s.absoluteRoot()
	if err != nil {
		return false
	}
	info, err := os.Stat(root)
	return err == nil && info.IsDir()
}

func (s *Scanner) Preview(limit int) (Preview, error) {
	preview := Preview{Configured: s.Configured(), RootLabel: s.root, Books: []Record{}, Errors: []string{}}
	if !preview.Configured {
		return preview, nil
	}
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	root, err := s.absoluteRoot()
	if err != nil {
		return preview, err
	}
	info, err := os.Stat(root)
	if errors.Is(err, os.ErrNotExist) {
		return preview, nil
	}
	if err != nil || !info.IsDir() {
		return preview, fmt.Errorf("inspect Calibre library root: %w", err)
	}
	if records, available, databaseErr := s.recordsFromMetadataDB(); available {
		if databaseErr != nil {
			return preview, databaseErr
		}
		for _, record := range records {
			preview.add(record, limit)
		}
		sort.Slice(preview.Books, func(i, j int) bool { return preview.Books[i].SourcePath < preview.Books[j].SourcePath })
		return preview, nil
	}

	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			preview.Errors = append(preview.Errors, walkErr.Error())
			return nil
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !strings.EqualFold(entry.Name(), "metadata.opf") {
			return nil
		}
		records, parseErr := s.recordsFromOPF(path)
		if parseErr != nil {
			preview.Errors = append(preview.Errors, parseErr.Error())
			return nil
		}
		for _, record := range records {
			preview.add(record, limit)
		}
		return nil
	})
	if err != nil {
		return preview, err
	}
	sort.Slice(preview.Books, func(i, j int) bool { return preview.Books[i].SourcePath < preview.Books[j].SourcePath })
	return preview, nil
}

func (p *Preview) add(record Record, limit int) {
	p.Total++
	switch record.OriginalFormat {
	case "pdf":
		p.PDFCount++
	case "epub":
		p.EPUBCount++
	case "mobi":
		p.MOBICount++
	case "azw3":
		p.AZW3Count++
	}
	if len(p.Books) < limit {
		p.Books = append(p.Books, record)
	}
}

func (s *Scanner) Load(sourcePath string) (Record, string, error) {
	absoluteSource, err := s.resolveRegularFile(sourcePath)
	if err != nil {
		return Record{}, "", err
	}
	extension := strings.ToLower(filepath.Ext(absoluteSource))
	if !supportedExtension(extension) {
		return Record{}, "", errors.New("Calibre source is not a supported PDF, EPUB, MOBI, or AZW3")
	}
	if records, available, databaseErr := s.recordsFromMetadataDB(); available {
		if databaseErr != nil {
			return Record{}, "", databaseErr
		}
		for _, record := range records {
			if record.SourcePath == filepath.ToSlash(sourcePath) {
				return record, absoluteSource, nil
			}
		}
		return Record{}, "", errors.New("Calibre source is not described by metadata.db")
	}
	opfPath := filepath.Join(filepath.Dir(absoluteSource), "metadata.opf")
	records, err := s.recordsFromOPF(opfPath)
	if err != nil {
		return Record{}, "", err
	}
	for _, record := range records {
		if record.SourcePath == filepath.ToSlash(sourcePath) {
			return record, absoluteSource, nil
		}
	}
	return Record{}, "", errors.New("Calibre source is not described by metadata.opf")
}

func (s *Scanner) recordsFromMetadataDB() ([]Record, bool, error) {
	metadataPath, err := s.resolveRegularFile("metadata.db")
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, true, fmt.Errorf("open Calibre metadata.db: %w", err)
	}
	databaseURL := (&url.URL{Scheme: "file", Path: metadataPath, RawQuery: "mode=ro"}).String()
	database, err := sql.Open("sqlite", databaseURL)
	if err != nil {
		return nil, true, fmt.Errorf("open Calibre metadata.db: %w", err)
	}
	defer database.Close()
	database.SetMaxOpenConns(1)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	authors, err := linkedNames(ctx, database, `SELECT link.book,author.name FROM books_authors_link link JOIN authors author ON author.id=link.author ORDER BY link.book,link.id`)
	if err != nil {
		return nil, true, fmt.Errorf("read Calibre authors: %w", err)
	}
	languages, err := linkedNames(ctx, database, `SELECT link.book,language.lang_code FROM books_languages_link link JOIN languages language ON language.id=link.lang_code ORDER BY link.book,link.item_order,link.id`)
	if err != nil {
		return nil, true, fmt.Errorf("read Calibre languages: %w", err)
	}
	publishers, err := linkedNames(ctx, database, `SELECT link.book,publisher.name FROM books_publishers_link link JOIN publishers publisher ON publisher.id=link.publisher ORDER BY link.book,link.id`)
	if err != nil {
		return nil, true, fmt.Errorf("read Calibre publishers: %w", err)
	}
	descriptions, err := linkedNames(ctx, database, `SELECT book,text FROM comments ORDER BY book,id`)
	if err != nil {
		return nil, true, fmt.Errorf("read Calibre comments: %w", err)
	}
	rows, err := database.QueryContext(ctx, `
		SELECT data.book,data.format,COALESCE(data.uncompressed_size,0),data.name,books.title,
			COALESCE(CAST(books.pubdate AS TEXT),''),COALESCE(books.isbn,''),COALESCE(books.path,''),
			COALESCE(books.uuid,''),COALESCE(books.has_cover,0)
		FROM data JOIN books ON books.id=data.book
		ORDER BY books.id,data.id`)
	if err != nil {
		return nil, true, fmt.Errorf("read Calibre book files: %w", err)
	}
	defer rows.Close()
	records := make([]Record, 0)
	for rows.Next() {
		var bookID int64
		var rawFormat, name, title, publicationDate, isbn, bookPath, uuid string
		var sizeBytes int64
		var hasCover int
		if err := rows.Scan(&bookID, &rawFormat, &sizeBytes, &name, &title, &publicationDate, &isbn, &bookPath, &uuid, &hasCover); err != nil {
			return nil, true, fmt.Errorf("scan Calibre book file: %w", err)
		}
		format := strings.ToLower(strings.TrimSpace(rawFormat))
		if !supportedExtension("." + format) {
			continue
		}
		relativeSource := filepath.ToSlash(filepath.Join(filepath.FromSlash(bookPath), name+"."+format))
		if _, err := s.resolveRegularFile(relativeSource); err != nil {
			continue
		}
		record := Record{
			SourcePath: relativeSource, MetadataPath: "metadata.db", Title: strings.TrimSpace(title),
			Authors: cleanUnique(authors[bookID]), PublishedYear: parseYear(publicationDate),
			Language: strings.ToLower(first(languages[bookID])), ISBN: strings.TrimSpace(isbn),
			Publisher: first(publishers[bookID]), Description: first(descriptions[bookID]),
			// Calibre tags deliberately remain in Calibre. PEUFMReader owns its
			// category tree and classification rules, so an external tag must not
			// become a category or influence automatic classification here.
			Subjects: []string{}, OriginalFormat: format, SizeBytes: sizeBytes,
		}
		if record.Title == "" {
			record.Title = strings.TrimSpace(name)
		}
		if uuid != "" {
			record.ReferenceKey = uuid + ":" + format
		} else {
			record.ReferenceKey = "path:" + relativeSource
		}
		if hasCover != 0 {
			coverRelative := filepath.ToSlash(filepath.Join(filepath.Dir(relativeSource), "cover.jpg"))
			if _, err := s.resolveRegularFile(coverRelative); err == nil {
				record.CoverPath = coverRelative
			}
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, true, fmt.Errorf("iterate Calibre book files: %w", err)
	}
	return records, true, nil
}

func linkedNames(ctx context.Context, database *sql.DB, query string) (map[int64][]string, error) {
	rows, err := database.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make(map[int64][]string)
	for rows.Next() {
		var bookID int64
		var value string
		if err := rows.Scan(&bookID, &value); err != nil {
			return nil, err
		}
		if value = strings.TrimSpace(value); value != "" {
			values[bookID] = append(values[bookID], value)
		}
	}
	return values, rows.Err()
}

// Open returns a read-only handle for a referenced Calibre book after applying
// the same containment and regular-file checks used during library scanning.
// It never follows a source path outside the configured Calibre library.
func (s *Scanner) Open(sourcePath string) (*os.File, error) {
	absoluteSource, err := s.resolveRegularFile(sourcePath)
	if err != nil {
		return nil, err
	}
	if !supportedExtension(filepath.Ext(absoluteSource)) {
		return nil, errors.New("Calibre source is not a supported PDF, EPUB, MOBI, or AZW3")
	}
	file, err := os.Open(absoluteSource)
	if err != nil {
		return nil, fmt.Errorf("open Calibre source: %w", err)
	}
	return file, nil
}

func (s *Scanner) recordsFromOPF(opfPath string) ([]Record, error) {
	root, err := s.absoluteRoot()
	if err != nil {
		return nil, err
	}
	metadataRelative, err := filepath.Rel(root, opfPath)
	if err != nil || !filepath.IsLocal(metadataRelative) {
		return nil, library.ErrUnsafePath
	}
	safeOPFPath, err := s.resolveRegularFile(filepath.ToSlash(metadataRelative))
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", opfPath, err)
	}
	file, err := os.Open(safeOPFPath)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", opfPath, err)
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxOPFBytes+1))
	if err != nil || len(content) > maxOPFBytes {
		return nil, fmt.Errorf("read %s: metadata.opf is invalid or too large", opfPath)
	}
	var document packageDocument
	if err := xml.Unmarshal(content, &document); err != nil {
		return nil, fmt.Errorf("parse %s: %w", opfPath, err)
	}
	directory := filepath.Dir(safeOPFPath)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	base := Record{
		Title:         first(document.Metadata.Titles),
		Authors:       cleanUnique(document.Metadata.Creators),
		PublishedYear: parseYear(first(document.Metadata.Dates)),
		Language:      strings.ToLower(strings.TrimSpace(first(document.Metadata.Languages))),
		ISBN:          calibreISBN(document.Metadata.Identifiers),
		Publisher:     first(document.Metadata.Publishers),
		Description:   first(document.Metadata.Descriptions),
		Subjects:      cleanUnique(document.Metadata.Subjects),
	}
	base.MetadataPath = filepath.ToSlash(metadataRelative)
	coverAbsolute := filepath.Join(directory, "cover.jpg")
	if coverRelative, err := filepath.Rel(root, coverAbsolute); err == nil {
		if _, err := s.resolveRegularFile(filepath.ToSlash(coverRelative)); err == nil {
			base.CoverPath = filepath.ToSlash(coverRelative)
		}
	}
	records := make([]Record, 0, 2)
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		extension := strings.ToLower(filepath.Ext(entry.Name()))
		if !supportedExtension(extension) {
			continue
		}
		absoluteSource := filepath.Join(directory, entry.Name())
		relativeSource, relErr := filepath.Rel(root, absoluteSource)
		if relErr != nil {
			continue
		}
		record := base
		record.SourcePath = filepath.ToSlash(relativeSource)
		record.OriginalFormat = strings.TrimPrefix(extension, ".")
		if record.Title == "" {
			record.Title = strings.TrimSuffix(entry.Name(), extension)
		}
		records = append(records, record)
	}
	return records, nil
}

func supportedExtension(extension string) bool {
	switch strings.ToLower(strings.TrimSpace(extension)) {
	case ".pdf", ".epub", ".mobi", ".azw3":
		return true
	default:
		return false
	}
}

func (s *Scanner) Metadata(record Record) (metadata.Result, error) {
	source := "calibre-metadata-opf"
	confidence := 0.98
	if strings.EqualFold(record.MetadataPath, "metadata.db") {
		source = "calibre-metadata-db"
		confidence = 0.99
	}
	result := metadata.Result{
		Title: record.Title, Authors: record.Authors, PublishedYear: record.PublishedYear,
		Language: record.Language, ISBN: record.ISBN, Publisher: record.Publisher,
		Description: record.Description, Subjects: record.Subjects,
		Source: source, Confidence: confidence,
	}
	if record.CoverPath == "" {
		return result, nil
	}
	absoluteCover, err := s.resolveRegularFile(record.CoverPath)
	if err != nil {
		return result, err
	}
	cover, err := os.ReadFile(absoluteCover)
	if err != nil {
		return result, fmt.Errorf("read Calibre cover: %w", err)
	}
	if len(cover) > 12<<20 {
		return result, errors.New("Calibre cover exceeds 12 MiB")
	}
	result.Cover = &metadata.Cover{Bytes: cover, Extension: "jpg", MIMEType: "image/jpeg"}
	return result, nil
}

func (s *Scanner) resolveRegularFile(sourcePath string) (string, error) {
	root, err := s.absoluteRoot()
	if err != nil {
		return "", err
	}
	absolutePath, err := library.SecureResolve(root, filepath.FromSlash(sourcePath))
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(absolutePath)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", errors.New("Calibre source must be a regular file inside the configured library")
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve Calibre library root: %w", err)
	}
	resolvedPath, err := filepath.EvalSymlinks(absolutePath)
	if err != nil {
		return "", fmt.Errorf("resolve Calibre source: %w", err)
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedPath)
	if err != nil || !filepath.IsLocal(relative) {
		return "", library.ErrUnsafePath
	}
	resolvedInfo, err := os.Stat(resolvedPath)
	if err != nil {
		return "", err
	}
	if !resolvedInfo.Mode().IsRegular() {
		return "", errors.New("Calibre source must be a regular file inside the configured library")
	}
	return resolvedPath, nil
}

func (s *Scanner) absoluteRoot() (string, error) {
	if strings.TrimSpace(s.root) == "" {
		return "", errors.New("Calibre library root is required")
	}
	root, err := filepath.Abs(s.root)
	if err != nil {
		return "", fmt.Errorf("resolve Calibre library root: %w", err)
	}
	return root, nil
}

func first(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return strings.TrimSpace(values[0])
}

func cleanUnique(values []string) []string {
	seen := make(map[string]struct{})
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
	}
	return result
}

func parseYear(value string) *int {
	if len(value) < 4 {
		return nil
	}
	year, err := strconv.Atoi(value[:4])
	if err != nil || year < 0 || year > 9999 {
		return nil
	}
	return &year
}

func calibreISBN(identifiers []struct {
	Value  string `xml:",chardata"`
	Scheme string `xml:"scheme,attr"`
}) string {
	for _, identifier := range identifiers {
		if strings.EqualFold(identifier.Scheme, "ISBN") || strings.Contains(strings.ToLower(identifier.Value), "isbn") {
			value := strings.TrimSpace(identifier.Value)
			value = strings.TrimPrefix(strings.ToLower(value), "isbn:")
			return strings.ToUpper(strings.TrimSpace(value))
		}
	}
	return ""
}
