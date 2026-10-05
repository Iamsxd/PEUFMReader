package textindex

import (
	"archive/zip"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"

	"peufmreader/internal/store"
)

const MaxTextBytes = 16 << 20

func chunks(text, label string, position map[string]any) []store.SearchPassage {
	text = strings.Join(strings.Fields(strings.ReplaceAll(strings.ToValidUTF8(text, "�"), "\x00", "")), " ")
	runes := []rune(text)
	result := make([]store.SearchPassage, 0)
	for start := 0; start < len(runes); start += 1400 {
		end := min(start+1600, len(runes))
		result = append(result, store.SearchPassage{Label: label, Position: position, Body: string(runes[start:end])})
		if end == len(runes) {
			break
		}
	}
	return result
}
func readEntry(files map[string]*zip.File, name string) ([]byte, error) {
	f := files[name]
	if f == nil {
		return nil, fmt.Errorf("EPUB entry missing: %s", name)
	}
	if f.UncompressedSize64 > 4<<20 {
		return nil, errors.New("EPUB chapter exceeds 4 MiB")
	}
	reader, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, (4<<20)+1))
	if len(data) > 4<<20 {
		return nil, errors.New("EPUB entry too large")
	}
	return data, err
}
func chapterText(data []byte) (string, string, error) {
	decoder := xml.NewDecoder(strings.NewReader(string(data)))
	decoder.Strict = false
	decoder.Entity = map[string]string{"nbsp": " ", "mdash": "—", "ndash": "–", "ldquo": "“", "rdquo": "”", "lsquo": "‘", "rsquo": "’", "hellip": "…"}
	var text, title strings.Builder
	body := false
	skip := 0
	heading := 0
	for {
		tok, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", "", err
		}
		switch token := tok.(type) {
		case xml.StartElement:
			name := strings.ToLower(token.Name.Local)
			if name == "body" {
				body = true
			}
			if skip > 0 || name == "script" || name == "style" {
				skip++
			}
			if skip == 0 && body && (name == "h1" || name == "h2") && title.Len() == 0 {
				heading = 1
			} else if heading > 0 {
				heading++
			}
			if body && skip == 0 {
				text.WriteByte(' ')
			}
		case xml.EndElement:
			if skip > 0 {
				skip--
			}
			if heading > 0 {
				heading--
			}
			if token.Name.Local == "body" {
				body = false
			}
			text.WriteByte(' ')
		case xml.CharData:
			if body && skip == 0 {
				text.Write(token)
				if heading > 0 {
					title.Write(token)
				}
			}
		}
	}
	return text.String(), strings.Join(strings.Fields(title.String()), " "), nil
}
func EPUB(reader io.ReaderAt, size int64) ([]store.SearchPassage, string, error) {
	archive, err := zip.NewReader(reader, size)
	if err != nil {
		return nil, "", err
	}
	if len(archive.File) > 20000 {
		return nil, "", errors.New("EPUB archive exceeds 20000 entries")
	}
	files := make(map[string]*zip.File)
	for _, f := range archive.File {
		if files[f.Name] != nil {
			return nil, "", errors.New("duplicate EPUB entry")
		}
		files[f.Name] = f
	}
	containerData, err := readEntry(files, "META-INF/container.xml")
	if err != nil {
		return nil, "", err
	}
	var container struct {
		Roots []struct {
			Path string `xml:"full-path,attr"`
		} `xml:"rootfiles>rootfile"`
	}
	if err = xml.Unmarshal(containerData, &container); err != nil || len(container.Roots) == 0 {
		return nil, "", errors.New("invalid EPUB container")
	}
	packagePath := path.Clean(container.Roots[0].Path)
	data, err := readEntry(files, packagePath)
	if err != nil {
		return nil, "", err
	}
	var pkg struct {
		Items []struct {
			ID    string `xml:"id,attr"`
			Href  string `xml:"href,attr"`
			Media string `xml:"media-type,attr"`
		} `xml:"manifest>item"`
		Spine []struct {
			ID     string `xml:"idref,attr"`
			Linear string `xml:"linear,attr"`
		} `xml:"spine>itemref"`
	}
	if err = xml.Unmarshal(data, &pkg); err != nil {
		return nil, "", err
	}
	items := make(map[string]string)
	for _, item := range pkg.Items {
		if item.Media == "application/xhtml+xml" || item.Media == "text/html" {
			items[item.ID] = item.Href
		}
	}
	result := make([]store.SearchPassage, 0)
	total := 0
	for index, item := range pkg.Spine {
		if item.Linear == "no" {
			continue
		}
		href := items[item.ID]
		if href == "" {
			continue
		}
		if len(href) > 2048 {
			return nil, "", errors.New("EPUB chapter href is too long")
		}
		parsed, err := url.Parse(href)
		if err != nil || parsed.IsAbs() || parsed.Host != "" || strings.HasPrefix(parsed.Path, "/") {
			return nil, "", errors.New("external EPUB chapter is not indexed")
		}
		entry := path.Clean(path.Join(path.Dir(packagePath), parsed.Path))
		if strings.HasPrefix(entry, "../") {
			return nil, "", errors.New("EPUB chapter escapes archive")
		}
		data, err = readEntry(files, entry)
		if err != nil {
			return nil, "", err
		}
		total += len(data)
		if total > MaxTextBytes {
			return nil, "", errors.New("EPUB text exceeds 16 MiB index limit")
		}
		text, title, err := chapterText(data)
		if err != nil {
			return nil, "", err
		}
		if title == "" {
			title = fmt.Sprintf("第 %d 章", index+1)
		}
		if len([]rune(title)) > 200 {
			title = string([]rune(title)[:200])
		}
		result = append(result, chunks(text, title, map[string]any{"href": href, "chapterIndex": index})...)
		if len(result) > 10000 {
			return nil, "", errors.New("EPUB exceeds 10000 passages")
		}
	}
	return result, "EPUB 正文（章节级定位）", nil
}

var ocrMarker = regexp.MustCompile(`(?m)^--- 第 ([0-9]+) 页 ---\s*$`)

func PDF(data []byte, method string, pageCount int) ([]store.SearchPassage, string, error) {
	if len(data) > MaxTextBytes {
		return nil, "", errors.New("PDF extracted text exceeds 16 MiB")
	}
	text := strings.ToValidUTF8(string(data), "�")
	result := make([]store.SearchPassage, 0)
	if strings.Contains(strings.ToLower(method), "ocr") {
		matches := ocrMarker.FindAllStringSubmatchIndex(text, -1)
		if len(matches) > 10000 {
			return nil, "", errors.New("PDF OCR exceeds 10000 pages")
		}
		if len(matches) == 0 {
			return chunks(text, "提取文本（无可靠页码）", map[string]any{}), "OCR 提取文本，页码不可用", nil
		}
		for i, match := range matches {
			page, _ := strconv.Atoi(text[match[2]:match[3]])
			end := len(text)
			if i+1 < len(matches) {
				end = matches[i+1][0]
			}
			result = append(result, chunks(text[match[1]:end], fmt.Sprintf("第 %d 页", page), map[string]any{"pageIndex": page - 1})...)
		}
		return result, fmt.Sprintf("OCR 已提取 %d 页（不保证全书覆盖）", len(matches)), nil
	}
	pages := strings.Split(text, "\f")
	if len(pages) > 10001 {
		return nil, "", errors.New("PDF exceeds 10000 pages")
	}
	if len(pages) > 1 && strings.TrimSpace(pages[len(pages)-1]) == "" {
		pages = pages[:len(pages)-1]
	}
	reliable := len(pages) > 1 || pageCount == 1
	for index, page := range pages {
		label := "提取文本（无可靠页码）"
		position := map[string]any{}
		if reliable {
			label = fmt.Sprintf("第 %d 页", index+1)
			position["pageIndex"] = index
		}
		result = append(result, chunks(page, label, position)...)
	}
	coverage := "PDF 已提取文本（无可靠页码）"
	if reliable {
		coverage = fmt.Sprintf("PDF 已提取 %d 页", len(pages))
	}
	return result, coverage, nil
}
