package calibre

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"peufmreader/internal/library"
	"peufmreader/internal/metadata"
)

const maxOPFBytes = 4 << 20

type Scanner struct {
	root string
}

type Record struct {
	SourcePath     string   `json:"sourcePath"`
	MetadataPath   string   `json:"metadataPath"`
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
}

type Preview struct {
	Configured bool     `json:"configured"`
	RootLabel  string   `json:"rootLabel"`
	Books      []Record `json:"books"`
	Total      int      `json:"total"`
	PDFCount   int      `json:"pdfCount"`
	EPUBCount  int      `json:"epubCount"`
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

func (s *Scanner) Preview(limit int) (Preview, error) {
	preview := Preview{Configured: s.root != "" && s.root != ".", RootLabel: s.root, Books: []Record{}, Errors: []string{}}
	if !preview.Configured {
		return preview, nil
	}
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	info, err := os.Stat(s.root)
	if errors.Is(err, os.ErrNotExist) {
		return preview, nil
	}
	if err != nil || !info.IsDir() {
		return preview, fmt.Errorf("inspect Calibre library root: %w", err)
	}

	err = filepath.WalkDir(s.root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			preview.Errors = append(preview.Errors, walkErr.Error())
			return nil
		}
		if entry.IsDir() || !strings.EqualFold(entry.Name(), "metadata.opf") {
			return nil
		}
		records, parseErr := s.recordsFromOPF(path)
		if parseErr != nil {
			preview.Errors = append(preview.Errors, parseErr.Error())
			return nil
		}
		for _, record := range records {
			preview.Total++
			if record.OriginalFormat == "pdf" {
				preview.PDFCount++
			} else if record.OriginalFormat == "epub" {
				preview.EPUBCount++
			}
			if len(preview.Books) < limit {
				preview.Books = append(preview.Books, record)
			}
		}
		return nil
	})
	if err != nil {
		return preview, err
	}
	sort.Slice(preview.Books, func(i, j int) bool { return preview.Books[i].SourcePath < preview.Books[j].SourcePath })
	return preview, nil
}

func (s *Scanner) Load(sourcePath string) (Record, string, error) {
	absoluteSource, err := library.SecureResolve(s.root, filepath.FromSlash(sourcePath))
	if err != nil {
		return Record{}, "", err
	}
	extension := strings.ToLower(filepath.Ext(absoluteSource))
	if extension != ".pdf" && extension != ".epub" {
		return Record{}, "", errors.New("Calibre source is not a supported PDF or EPUB")
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

func (s *Scanner) recordsFromOPF(opfPath string) ([]Record, error) {
	file, err := os.Open(opfPath)
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
	directory := filepath.Dir(opfPath)
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
	metadataRelative, err := filepath.Rel(s.root, opfPath)
	if err != nil {
		return nil, err
	}
	base.MetadataPath = filepath.ToSlash(metadataRelative)
	coverAbsolute := filepath.Join(directory, "cover.jpg")
	if _, err := os.Stat(coverAbsolute); err == nil {
		coverRelative, _ := filepath.Rel(s.root, coverAbsolute)
		base.CoverPath = filepath.ToSlash(coverRelative)
	}
	records := make([]Record, 0, 2)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		extension := strings.ToLower(filepath.Ext(entry.Name()))
		if extension != ".pdf" && extension != ".epub" {
			continue
		}
		absoluteSource := filepath.Join(directory, entry.Name())
		relativeSource, relErr := filepath.Rel(s.root, absoluteSource)
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

func (s *Scanner) Metadata(record Record) (metadata.Result, error) {
	result := metadata.Result{
		Title: record.Title, Authors: record.Authors, PublishedYear: record.PublishedYear,
		Language: record.Language, ISBN: record.ISBN, Publisher: record.Publisher,
		Description: record.Description, Subjects: record.Subjects,
		Source: "calibre-metadata-opf", Confidence: 0.98,
	}
	if record.CoverPath == "" {
		return result, nil
	}
	absoluteCover, err := library.SecureResolve(s.root, filepath.FromSlash(record.CoverPath))
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
