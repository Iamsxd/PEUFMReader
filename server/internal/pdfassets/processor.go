package pdfassets

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

const JobKind = "pdf-assets"

var pagesPattern = regexp.MustCompile(`(?m)^Pages:\s+([0-9]+)\s*$`)

type Config struct {
	OCRMode       string
	OCRLanguages  string
	OCRMaxPages   int
	OCRDPI        int
	PDFInfoPath   string
	PDFToTextPath string
	PDFToPPMPath  string
	TesseractPath string
}

type Result struct {
	Cover      []byte
	Text       []byte
	TextMethod string
	PageCount  int
	OCRUsed    bool
	Warnings   []string
}

type Processor struct {
	config Config
}

func NewProcessor(config Config) *Processor {
	if config.OCRMode == "" {
		config.OCRMode = "auto"
	}
	if config.OCRLanguages == "" {
		config.OCRLanguages = "chi_sim+eng"
	}
	if config.OCRMaxPages <= 0 {
		config.OCRMaxPages = 500
	}
	if config.OCRDPI <= 0 {
		config.OCRDPI = 180
	}
	if config.PDFInfoPath == "" {
		config.PDFInfoPath = "pdfinfo"
	}
	if config.PDFToTextPath == "" {
		config.PDFToTextPath = "pdftotext"
	}
	if config.PDFToPPMPath == "" {
		config.PDFToPPMPath = "pdftoppm"
	}
	if config.TesseractPath == "" {
		config.TesseractPath = "tesseract"
	}
	return &Processor{config: config}
}

func (p *Processor) Process(ctx context.Context, inputPath string) (Result, error) {
	tempDir, err := os.MkdirTemp("", "peufm-pdf-assets-*")
	if err != nil {
		return Result{}, fmt.Errorf("create PDF processing directory: %w", err)
	}
	defer os.RemoveAll(tempDir)

	pageCount, err := p.pageCount(ctx, inputPath)
	if err != nil {
		return Result{}, err
	}
	cover, err := p.renderCover(ctx, inputPath, tempDir)
	if err != nil {
		return Result{}, err
	}
	embeddedText, err := p.extractEmbeddedText(ctx, inputPath)
	if err != nil {
		return Result{}, err
	}
	result := Result{Cover: cover, PageCount: pageCount, Warnings: []string{}}
	needsOCR := p.config.OCRMode == "always" || p.config.OCRMode == "auto" && !hasMeaningfulText(embeddedText, pageCount)
	if !needsOCR {
		if len(bytes.TrimSpace(embeddedText)) > 0 {
			result.Text = embeddedText
			result.TextMethod = "embedded"
		}
		return result, nil
	}
	if p.config.OCRMode == "disabled" {
		result.Warnings = append(result.Warnings, "PDF 没有足够的可提取文本，OCR 已禁用")
		return result, nil
	}

	ocrPages := min(pageCount, p.config.OCRMaxPages)
	if ocrPages < pageCount {
		result.Warnings = append(result.Warnings, fmt.Sprintf("PDF 共 %d 页，仅 OCR 前 %d 页", pageCount, ocrPages))
	}
	ocrText, err := p.ocr(ctx, inputPath, tempDir, ocrPages)
	if err != nil {
		return Result{}, err
	}
	result.OCRUsed = true
	if len(bytes.TrimSpace(ocrText)) > 0 {
		result.Text = ocrText
		result.TextMethod = "ocr"
	} else {
		result.Warnings = append(result.Warnings, "OCR 未识别出文本")
	}
	return result, nil
}

func (p *Processor) pageCount(ctx context.Context, inputPath string) (int, error) {
	output, err := runCommand(ctx, p.config.PDFInfoPath, inputPath)
	if err != nil {
		return 0, fmt.Errorf("inspect PDF pages: %w", err)
	}
	match := pagesPattern.FindSubmatch(output)
	if len(match) != 2 {
		return 0, errors.New("pdfinfo did not report a page count")
	}
	pageCount, err := strconv.Atoi(string(match[1]))
	if err != nil || pageCount <= 0 {
		return 0, errors.New("PDF page count is invalid")
	}
	return pageCount, nil
}

func (p *Processor) renderCover(ctx context.Context, inputPath, tempDir string) ([]byte, error) {
	prefix := filepath.Join(tempDir, "cover")
	_, err := runCommand(ctx, p.config.PDFToPPMPath,
		"-f", "1", "-l", "1", "-singlefile", "-jpeg", "-jpegopt", "quality=85", "-scale-to", "1200", inputPath, prefix)
	if err != nil {
		return nil, fmt.Errorf("render PDF cover: %w", err)
	}
	cover, err := os.ReadFile(prefix + ".jpg")
	if err != nil {
		return nil, fmt.Errorf("read rendered PDF cover: %w", err)
	}
	if len(cover) == 0 || len(cover) > 12<<20 {
		return nil, errors.New("rendered PDF cover size is invalid")
	}
	return cover, nil
}

func (p *Processor) extractEmbeddedText(ctx context.Context, inputPath string) ([]byte, error) {
	output, err := runCommand(ctx, p.config.PDFToTextPath, "-enc", "UTF-8", inputPath, "-")
	if err != nil {
		return nil, fmt.Errorf("extract PDF text: %w", err)
	}
	return output, nil
}

func (p *Processor) ocr(ctx context.Context, inputPath, tempDir string, pageCount int) ([]byte, error) {
	var text bytes.Buffer
	for page := 1; page <= pageCount; page++ {
		prefix := filepath.Join(tempDir, "ocr-page")
		_, err := runCommand(ctx, p.config.PDFToPPMPath,
			"-f", strconv.Itoa(page), "-l", strconv.Itoa(page), "-singlefile", "-r", strconv.Itoa(p.config.OCRDPI), "-png", inputPath, prefix)
		if err != nil {
			return nil, fmt.Errorf("render PDF page %d for OCR: %w", page, err)
		}
		imagePath := prefix + ".png"
		pageText, err := runCommand(ctx, p.config.TesseractPath, imagePath, "stdout", "-l", p.config.OCRLanguages, "--psm", "3")
		_ = os.Remove(imagePath)
		if err != nil {
			return nil, fmt.Errorf("OCR PDF page %d: %w", page, err)
		}
		if len(bytes.TrimSpace(pageText)) == 0 {
			continue
		}
		fmt.Fprintf(&text, "\n\n--- 第 %d 页 ---\n\n", page)
		text.Write(bytes.TrimSpace(pageText))
		text.WriteByte('\n')
	}
	return text.Bytes(), nil
}

func runCommand(ctx context.Context, name string, arguments ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, arguments...)
	command.Env = append(os.Environ(), "LC_ALL=C", "LANG=C.UTF-8")
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if len(detail) > 500 {
			detail = detail[:500]
		}
		if detail != "" {
			return nil, fmt.Errorf("%w: %s", err, detail)
		}
		return nil, err
	}
	return stdout.Bytes(), nil
}

func hasMeaningfulText(content []byte, pageCount int) bool {
	meaningful := 0
	for _, character := range string(content) {
		if unicode.IsLetter(character) || unicode.IsNumber(character) {
			meaningful++
		}
	}
	threshold := min(max(pageCount, 1)*40, 800)
	return meaningful >= threshold
}
