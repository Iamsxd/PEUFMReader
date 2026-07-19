package importinbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"peufmreader/internal/importing"
	"peufmreader/internal/jobs"
	"peufmreader/internal/store"
)

func Handler(manager *Manager, importer *importing.Service) jobs.Handler {
	return func(ctx context.Context, job store.BackgroundJob) (any, error) {
		if job.CreatedBy == nil {
			return nil, errors.New("inbox import job has no initiating user")
		}
		var payload Payload
		if err := json.Unmarshal(job.Payload, &payload); err != nil || payload.SourcePath == "" || payload.OriginalFilename == "" {
			return nil, errors.New("inbox import job payload is invalid")
		}
		_ = jobs.ReportProgress(ctx, 10, "读取导入收件箱文件")
		file, err := manager.Open(payload.SourcePath, job.DedupeKey)
		if err != nil {
			return nil, err
		}
		_ = jobs.ReportProgress(ctx, 30, "提取元数据并复制到书库")
		result, importErr := importer.Import(ctx, *job.CreatedBy, "导入收件箱: "+payload.OriginalFilename, payload.OriginalFilename, file, nil)
		_ = file.Close()
		if importErr != nil {
			if job.Attempts >= job.MaxAttempts {
				if _, quarantineErr := manager.Quarantine(payload.SourcePath, job.DedupeKey, importErr); quarantineErr != nil {
					return nil, fmt.Errorf("%w; quarantine failed: %v", importErr, quarantineErr)
				}
			}
			return nil, importErr
		}
		_ = jobs.ReportProgress(ctx, 90, "归档收件箱源文件")
		archivePath, err := manager.Complete(payload.SourcePath, job.DedupeKey)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"bookFileId": result.Book.ID, "title": result.Book.Title, "duplicate": result.Duplicate,
			"importJobId": result.ImportJobID, "archivePath": archivePath,
		}, nil
	}
}
