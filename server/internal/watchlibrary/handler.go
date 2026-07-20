package watchlibrary

import (
	"context"
	"encoding/json"
	"errors"

	"peufmreader/internal/importing"
	"peufmreader/internal/jobs"
	"peufmreader/internal/store"
)

func Handler(manager *Manager, importer *importing.Service) jobs.Handler {
	return func(ctx context.Context, job store.BackgroundJob) (any, error) {
		if job.CreatedBy == nil {
			return nil, errors.New("watched library import job has no initiating user")
		}
		var payload Payload
		if err := json.Unmarshal(job.Payload, &payload); err != nil || payload.SourcePath == "" || payload.OriginalFilename == "" {
			return nil, errors.New("watched library import payload is invalid")
		}
		_ = jobs.ReportProgress(ctx, 10, "读取只读监控目录文件")
		file, err := manager.Open(payload.SourcePath, job.DedupeKey)
		if err != nil {
			return nil, err
		}
		_ = jobs.ReportProgress(ctx, 30, "复制文件并提取元数据")
		result, importErr := importer.Import(ctx, *job.CreatedBy, "只读监控目录: "+payload.SourcePath, payload.OriginalFilename, file, nil)
		_ = file.Close()
		if importErr != nil {
			return nil, importErr
		}
		_ = jobs.ReportProgress(ctx, 95, "源文件保留在原位置")
		return map[string]any{
			"bookFileId": result.Book.ID, "title": result.Book.Title, "duplicate": result.Duplicate,
			"importJobId": result.ImportJobID, "sourcePath": payload.SourcePath, "sourceRetained": true,
		}, nil
	}
}
