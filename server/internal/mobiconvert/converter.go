package mobiconvert

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	ErrUnsupportedFormat     = errors.New("unsupported Kindle ebook format")
	ErrConversionUnavailable = errors.New("MOBI/AZW3 converter is unavailable")
	ErrConversionFailed      = errors.New("MOBI/AZW3 conversion failed")
)

type Result struct {
	Path    string
	Created bool
}

type commandRunner func(context.Context, string, string, string) ([]byte, error)

type Converter struct {
	binary         string
	conversionRoot string
	timeout        time.Duration
	run            commandRunner
	locks          sync.Map
}

func New(cacheRoot, binary string, timeout time.Duration) (*Converter, error) {
	cacheRoot = strings.TrimSpace(cacheRoot)
	if cacheRoot == "" {
		return nil, errors.New("cache root is required for MOBI/AZW3 conversion")
	}
	binary = strings.TrimSpace(binary)
	if binary == "" {
		binary = "mobitool"
	}
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	root := filepath.Join(cacheRoot, "conversions")
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("create conversion cache: %w", err)
	}
	return &Converter{binary: binary, conversionRoot: root, timeout: timeout, run: runMobitool}, nil
}

func IsKindleFormat(format string) bool {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "mobi", "azw3":
		return true
	default:
		return false
	}
}

func (c *Converter) EnsureEPUB(ctx context.Context, sourcePath, sourceFormat, sha256Hex string) (Result, error) {
	if !IsKindleFormat(sourceFormat) {
		return Result{}, ErrUnsupportedFormat
	}
	finalPath, err := c.epubPath(sha256Hex)
	if err != nil {
		return Result{}, err
	}
	lockValue, _ := c.locks.LoadOrStore(sha256Hex, &sync.Mutex{})
	lock := lockValue.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()

	if validEPUB(finalPath) {
		return Result{Path: finalPath}, nil
	}
	if err := os.Remove(finalPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Result{}, fmt.Errorf("remove invalid conversion cache: %w", err)
	}
	if _, err := os.Stat(sourcePath); err != nil {
		return Result{}, fmt.Errorf("inspect Kindle source: %w", err)
	}
	destinationDir := filepath.Dir(finalPath)
	if err := os.MkdirAll(destinationDir, 0o750); err != nil {
		return Result{}, fmt.Errorf("create conversion directory: %w", err)
	}
	workDir, err := os.MkdirTemp(destinationDir, ".mobi-convert-*")
	if err != nil {
		return Result{}, fmt.Errorf("create conversion workspace: %w", err)
	}
	defer os.RemoveAll(workDir)

	conversionContext, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	output, err := c.run(conversionContext, c.binary, sourcePath, workDir)
	if err != nil {
		if errors.Is(conversionContext.Err(), context.DeadlineExceeded) {
			return Result{}, fmt.Errorf("%w: conversion exceeded %s", ErrConversionFailed, c.timeout)
		}
		message := strings.TrimSpace(string(output))
		if len(message) > 4000 {
			message = message[len(message)-4000:]
		}
		if errors.Is(err, exec.ErrNotFound) {
			return Result{}, fmt.Errorf("%w: %s", ErrConversionUnavailable, c.binary)
		}
		if message == "" {
			message = err.Error()
		}
		return Result{}, fmt.Errorf("%w: %s", ErrConversionFailed, message)
	}
	generatedPath, err := findGeneratedEPUB(workDir)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrConversionFailed, err)
	}
	if !validEPUB(generatedPath) {
		return Result{}, fmt.Errorf("%w: converter output is not a valid EPUB", ErrConversionFailed)
	}
	if err := os.Chmod(generatedPath, 0o640); err != nil {
		return Result{}, fmt.Errorf("set converted EPUB permissions: %w", err)
	}
	if err := os.Rename(generatedPath, finalPath); err != nil {
		return Result{}, fmt.Errorf("commit converted EPUB: %w", err)
	}
	return Result{Path: finalPath, Created: true}, nil
}

func (c *Converter) RemoveIfCreated(result Result) {
	if result.Created {
		_ = os.Remove(result.Path)
	}
}

func (c *Converter) epubPath(sha256Hex string) (string, error) {
	decoded, err := hex.DecodeString(strings.TrimSpace(sha256Hex))
	if err != nil || len(decoded) != sha256.Size {
		return "", errors.New("source hash is invalid")
	}
	return filepath.Join(c.conversionRoot, sha256Hex[:2], sha256Hex+".epub"), nil
}

func runMobitool(ctx context.Context, binary, sourcePath, outputDir string) ([]byte, error) {
	command := exec.CommandContext(ctx, binary, "-e", "-o", outputDir, sourcePath)
	var output limitedBuffer
	command.Stdout = &output
	command.Stderr = &output
	err := command.Run()
	return output.Bytes(), err
}

type limitedBuffer struct {
	buffer bytes.Buffer
}

func (b *limitedBuffer) Write(content []byte) (int, error) {
	const maxOutputBytes = 64 << 10
	originalLength := len(content)
	remaining := maxOutputBytes - b.buffer.Len()
	if remaining > 0 {
		if len(content) > remaining {
			content = content[:remaining]
		}
		_, _ = b.buffer.Write(content)
	}
	return originalLength, nil
}

func (b *limitedBuffer) Bytes() []byte {
	return b.buffer.Bytes()
}

func findGeneratedEPUB(root string) (string, error) {
	result := ""
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".epub") {
			return nil
		}
		if result != "" {
			return errors.New("converter produced multiple EPUB files")
		}
		result = path
		return nil
	})
	if err != nil {
		return "", err
	}
	if result == "" {
		return "", errors.New("converter did not produce an EPUB file")
	}
	return result, nil
}

func validEPUB(path string) bool {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return false
	}
	defer archive.Close()
	for _, entry := range archive.File {
		if entry.Name != "mimetype" || entry.UncompressedSize64 > 128 {
			continue
		}
		reader, err := entry.Open()
		if err != nil {
			return false
		}
		content, readErr := io.ReadAll(io.LimitReader(reader, 128))
		_ = reader.Close()
		return readErr == nil && strings.TrimSpace(string(content)) == "application/epub+zip"
	}
	return false
}
