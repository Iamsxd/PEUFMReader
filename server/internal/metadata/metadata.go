package metadata

import (
	"archive/zip"
	"bytes"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

const (
	maxMetadataEntryBytes = 4 << 20
	maxCoverBytes         = 12 << 20
	pdfWindowBytes        = 4 << 20
)

var (
	yearPattern     = regexp.MustCompile(`(?i)(?:^|\D)((?:1[0-9]{3}|20[0-9]{2}|2100))`)
	isbnPattern     = regexp.MustCompile(`(?i)(?:ISBN(?:-1[03])?[:\s]*)?([0-9X][0-9X\-\s]{8,20}[0-9X])`)
	htmlTagPattern  = regexp.MustCompile(`<[^>]+>`)
	pdfInfoPattern  = regexp.MustCompile(`(?s)/(Title|Author|Subject|Keywords|CreationDate)\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>)`)
	whitespace      = regexp.MustCompile(`\s+`)
	subjectSplitter = regexp.MustCompile(`[,;；，|/]+`)
)

type Result struct {
	Title         string
	Authors       []string
	PublishedYear *int
	Language      string
	ISBN          string
	Publisher     string
	Description   string
	Subjects      []string
	Source        string
	Confidence    float64
	Warnings      []string
	Cover         *Cover
}

type Cover struct {
	Bytes     []byte
	Extension string
	MIMEType  string
}

func Extract(filePath, format, originalFilename string) (Result, error) {
	var result Result
	var err error
	switch format {
	case "epub":
		result, err = extractEPUB(filePath)
	case "pdf":
		result, err = extractPDF(filePath)
	default:
		return Result{}, fmt.Errorf("unsupported metadata format %q", format)
	}
	if err != nil {
		return Result{}, err
	}
	result.Title = cleanText(result.Title)
	result.Authors = uniqueClean(result.Authors)
	result.Subjects = uniqueClean(result.Subjects)
	result.Language = strings.ToLower(cleanText(result.Language))
	result.ISBN = normalizeISBN(result.ISBN)
	result.Publisher = cleanText(result.Publisher)
	result.Description = cleanDescription(result.Description)
	if result.Title == "" {
		result.Title = strings.TrimSpace(strings.TrimSuffix(filepath.Base(originalFilename), filepath.Ext(originalFilename)))
		if result.Title == "" {
			result.Title = "Untitled"
		}
		result.Confidence = 0.35
		result.Source = "filename"
		result.Warnings = append(result.Warnings, "未找到内嵌书名，已使用文件名")
	}
	return result, nil
}

type epubContainer struct {
	Rootfiles []struct {
		FullPath string `xml:"full-path,attr"`
	} `xml:"rootfiles>rootfile"`
}

type epubPackage struct {
	Metadata struct {
		Titles      []string `xml:"title"`
		Creators    []string `xml:"creator"`
		Languages   []string `xml:"language"`
		Dates       []string `xml:"date"`
		Identifiers []struct {
			Value  string `xml:",chardata"`
			Scheme string `xml:"scheme,attr"`
		} `xml:"identifier"`
		Publishers   []string `xml:"publisher"`
		Descriptions []string `xml:"description"`
		Subjects     []string `xml:"subject"`
		Meta         []struct {
			Name     string `xml:"name,attr"`
			Content  string `xml:"content,attr"`
			Property string `xml:"property,attr"`
			Value    string `xml:",chardata"`
		} `xml:"meta"`
	} `xml:"metadata"`
	Manifest []struct {
		ID         string `xml:"id,attr"`
		Href       string `xml:"href,attr"`
		MediaType  string `xml:"media-type,attr"`
		Properties string `xml:"properties,attr"`
	} `xml:"manifest>item"`
}

func extractEPUB(filePath string) (Result, error) {
	archive, err := zip.OpenReader(filePath)
	if err != nil {
		return Result{}, fmt.Errorf("open EPUB: %w", err)
	}
	defer archive.Close()

	containerBytes, err := readZipEntry(archive.File, "META-INF/container.xml", maxMetadataEntryBytes)
	if err != nil {
		return Result{}, fmt.Errorf("read EPUB container: %w", err)
	}
	var container epubContainer
	if err := xml.Unmarshal(containerBytes, &container); err != nil || len(container.Rootfiles) == 0 {
		return Result{}, errors.New("EPUB container has no valid package document")
	}
	opfPath := cleanArchivePath(container.Rootfiles[0].FullPath)
	if opfPath == "" {
		return Result{}, errors.New("EPUB package path is unsafe")
	}
	opfBytes, err := readZipEntry(archive.File, opfPath, maxMetadataEntryBytes)
	if err != nil {
		return Result{}, fmt.Errorf("read EPUB package: %w", err)
	}
	var pkg epubPackage
	if err := xml.Unmarshal(opfBytes, &pkg); err != nil {
		return Result{}, fmt.Errorf("parse EPUB package: %w", err)
	}

	result := Result{Source: "epub-opf", Confidence: 0.95}
	if len(pkg.Metadata.Titles) > 0 {
		result.Title = pkg.Metadata.Titles[0]
	}
	result.Authors = pkg.Metadata.Creators
	if len(pkg.Metadata.Languages) > 0 {
		result.Language = pkg.Metadata.Languages[0]
	}
	if len(pkg.Metadata.Dates) > 0 {
		result.PublishedYear = parseYear(pkg.Metadata.Dates[0])
	}
	for _, identifier := range pkg.Metadata.Identifiers {
		if strings.Contains(strings.ToLower(identifier.Scheme), "isbn") || strings.Contains(strings.ToLower(identifier.Value), "isbn") {
			if value := normalizeISBN(identifier.Value); value != "" {
				result.ISBN = value
				break
			}
		}
	}
	if result.ISBN == "" {
		for _, identifier := range pkg.Metadata.Identifiers {
			if value := normalizeISBN(identifier.Value); value != "" {
				result.ISBN = value
				break
			}
		}
	}
	if len(pkg.Metadata.Publishers) > 0 {
		result.Publisher = pkg.Metadata.Publishers[0]
	}
	if len(pkg.Metadata.Descriptions) > 0 {
		result.Description = pkg.Metadata.Descriptions[0]
	}
	result.Subjects = pkg.Metadata.Subjects
	result.Cover = extractEPUBCover(archive.File, opfPath, pkg)
	if result.Cover == nil {
		result.Warnings = append(result.Warnings, "EPUB 未声明可提取的封面")
	}
	return result, nil
}

func extractEPUBCover(entries []*zip.File, opfPath string, pkg epubPackage) *Cover {
	coverID := ""
	for _, meta := range pkg.Metadata.Meta {
		if strings.EqualFold(meta.Name, "cover") {
			coverID = strings.TrimSpace(meta.Content)
			break
		}
	}
	var coverHref, mediaType string
	for _, item := range pkg.Manifest {
		if (coverID != "" && item.ID == coverID) || strings.Contains(" "+item.Properties+" ", " cover-image ") {
			coverHref, mediaType = item.Href, item.MediaType
			break
		}
	}
	if coverHref == "" {
		return nil
	}
	coverPath := cleanArchivePath(path.Join(path.Dir(opfPath), coverHref))
	if coverPath == "" {
		return nil
	}
	content, err := readZipEntry(entries, coverPath, maxCoverBytes)
	if err != nil {
		return nil
	}
	extension := extensionForMIME(mediaType)
	if extension == "" {
		extension = strings.ToLower(strings.TrimPrefix(path.Ext(coverPath), "."))
	}
	if extension != "jpg" && extension != "jpeg" && extension != "png" && extension != "webp" && extension != "gif" {
		return nil
	}
	if mediaType == "" {
		if extension == "jpg" || extension == "jpeg" {
			mediaType = "image/jpeg"
		} else {
			mediaType = "image/" + extension
		}
	}
	return &Cover{Bytes: content, Extension: extension, MIMEType: mediaType}
}

func extractPDF(filePath string) (Result, error) {
	content, err := readPDFWindows(filePath)
	if err != nil {
		return Result{}, err
	}
	values := make(map[string]string)
	for _, match := range pdfInfoPattern.FindAllSubmatch(content, -1) {
		key := string(match[1])
		if _, exists := values[key]; !exists {
			values[key] = decodePDFValue(match[2])
		}
	}
	result := Result{
		Title:      values["Title"],
		Source:     "pdf-info",
		Confidence: 0.82,
	}
	if author := cleanText(values["Author"]); author != "" {
		result.Authors = splitPeople(author)
	}
	result.PublishedYear = parseYear(values["CreationDate"])
	for _, value := range []string{values["Subject"], values["Keywords"]} {
		for _, subject := range subjectSplitter.Split(value, -1) {
			if subject = cleanText(subject); subject != "" {
				result.Subjects = append(result.Subjects, subject)
			}
		}
	}
	if result.Title == "" && len(result.Authors) == 0 && len(result.Subjects) == 0 {
		result.Source = "filename"
		result.Confidence = 0.35
		result.Warnings = append(result.Warnings, "PDF 未找到可用的 Info 元数据")
	}
	result.Warnings = append(result.Warnings, "PDF 封面生成尚未启用")
	return result, nil
}

func readPDFWindows(filePath string) ([]byte, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("open PDF metadata: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect PDF metadata: %w", err)
	}
	if info.Size() <= 2*pdfWindowBytes {
		return io.ReadAll(io.LimitReader(file, 2*pdfWindowBytes+1))
	}
	start := make([]byte, pdfWindowBytes)
	end := make([]byte, pdfWindowBytes)
	if _, err := io.ReadFull(file, start); err != nil {
		return nil, err
	}
	if _, err := file.ReadAt(end, info.Size()-pdfWindowBytes); err != nil {
		return nil, err
	}
	return append(append(start, '\n'), end...), nil
}

func decodePDFValue(raw []byte) string {
	if len(raw) >= 2 && raw[0] == '<' {
		compact := whitespace.ReplaceAll(raw[1:len(raw)-1], nil)
		decoded := make([]byte, hex.DecodedLen(len(compact)))
		n, err := hex.Decode(decoded, compact)
		if err != nil {
			return ""
		}
		return decodePDFText(decoded[:n])
	}
	if len(raw) < 2 {
		return ""
	}
	value := raw[1 : len(raw)-1]
	decoded := make([]byte, 0, len(value))
	for index := 0; index < len(value); index++ {
		if value[index] != '\\' || index+1 >= len(value) {
			decoded = append(decoded, value[index])
			continue
		}
		index++
		switch value[index] {
		case 'n':
			decoded = append(decoded, '\n')
		case 'r':
			decoded = append(decoded, '\r')
		case 't':
			decoded = append(decoded, '\t')
		case 'b':
			decoded = append(decoded, '\b')
		case 'f':
			decoded = append(decoded, '\f')
		case '\n', '\r':
			// Escaped line continuation.
		default:
			if value[index] >= '0' && value[index] <= '7' {
				octal := []byte{value[index]}
				for len(octal) < 3 && index+1 < len(value) && value[index+1] >= '0' && value[index+1] <= '7' {
					index++
					octal = append(octal, value[index])
				}
				if number, err := strconv.ParseUint(string(octal), 8, 8); err == nil {
					decoded = append(decoded, byte(number))
				}
			} else {
				decoded = append(decoded, value[index])
			}
		}
	}
	return decodePDFText(decoded)
}

func decodePDFText(value []byte) string {
	if len(value) >= 2 && value[0] == 0xfe && value[1] == 0xff {
		units := make([]uint16, 0, (len(value)-2)/2)
		for index := 2; index+1 < len(value); index += 2 {
			units = append(units, uint16(value[index])<<8|uint16(value[index+1]))
		}
		return string(utf16.Decode(units))
	}
	return string(value)
}

func readZipEntry(entries []*zip.File, name string, maxBytes int64) ([]byte, error) {
	for _, entry := range entries {
		if cleanArchivePath(entry.Name) != name {
			continue
		}
		if entry.UncompressedSize64 > uint64(maxBytes) {
			return nil, errors.New("EPUB metadata entry is too large")
		}
		reader, err := entry.Open()
		if err != nil {
			return nil, err
		}
		defer reader.Close()
		content, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
		if err != nil {
			return nil, err
		}
		if int64(len(content)) > maxBytes {
			return nil, errors.New("EPUB metadata entry is too large")
		}
		return content, nil
	}
	return nil, os.ErrNotExist
}

func cleanArchivePath(value string) string {
	value = strings.TrimPrefix(strings.ReplaceAll(value, "\\", "/"), "/")
	cleaned := path.Clean(value)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return ""
	}
	return cleaned
}

func parseYear(value string) *int {
	match := yearPattern.FindStringSubmatch(value)
	if len(match) < 2 {
		return nil
	}
	year, err := strconv.Atoi(match[1])
	if err != nil {
		return nil
	}
	return &year
}

func normalizeISBN(value string) string {
	match := isbnPattern.FindStringSubmatch(value)
	if len(match) < 2 {
		return ""
	}
	normalized := strings.NewReplacer("-", "", " ", "").Replace(strings.ToUpper(match[1]))
	if len(normalized) != 10 && len(normalized) != 13 {
		return ""
	}
	return normalized
}

func splitPeople(value string) []string {
	parts := regexp.MustCompile(`\s*(?:;|；|\band\b|&)\s*`).Split(value, -1)
	return uniqueClean(parts)
}

func uniqueClean(values []string) []string {
	seen := make(map[string]bool)
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = cleanText(value)
		key := strings.ToLower(value)
		if value == "" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, value)
	}
	return result
}

func cleanDescription(value string) string {
	return cleanText(html.UnescapeString(htmlTagPattern.ReplaceAllString(value, " ")))
}

func cleanText(value string) string {
	return strings.TrimSpace(whitespace.ReplaceAllString(value, " "))
}

func extensionForMIME(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "image/jpeg":
		return "jpg"
	case "image/png":
		return "png"
	case "image/webp":
		return "webp"
	case "image/gif":
		return "gif"
	default:
		return ""
	}
}

func EqualCover(a, b *Cover) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Extension == b.Extension && a.MIMEType == b.MIMEType && bytes.Equal(a.Bytes, b.Bytes)
}
