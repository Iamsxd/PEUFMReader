package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// ManagedUploadSizes excludes Calibre references: their sha256 is a locator,
// not a content digest.
func (s *Store) ManagedUploadSizes(ctx context.Context, sizes []int64) ([]int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT size_bytes FROM book_files WHERE storage_mode='managed' AND size_bytes=ANY($1::bigint[])`, sizes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []int64{}
	for rows.Next() {
		var size int64
		if err := rows.Scan(&size); err != nil {
			return nil, err
		}
		result = append(result, size)
	}
	return result, rows.Err()
}

func (s *Store) GetManagedBookByHash(ctx context.Context, hash []byte) (BookFile, bool, error) {
	book, err := scanCatalogBook(s.pool.QueryRow(ctx, catalogBookSelect+" WHERE bf.sha256=$1 AND bf.storage_mode='managed'", hash))
	if errors.Is(err, pgx.ErrNoRows) {
		return BookFile{}, false, nil
	}
	return book, err == nil, err
}

// RecordSkippedUpload is idempotent per queue item, including retries after a
// lost HTTP response. Only the owner of the batch can append a report entry.
func (s *Store) RecordSkippedUpload(ctx context.Context, userID, batchID, bookID int64, key, filename string) (int64, error) {
	var jobID int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO import_jobs(state,outcome,source_name,created_by,batch_id,book_file_id,client_key,warnings)
		SELECT 'completed','duplicate',$1,$2,id,$3,$4,'["书库已存在，已跳过上传"]'::jsonb FROM import_batches
		WHERE id=$5 AND created_by=$2
		ON CONFLICT (batch_id,client_key) WHERE client_key IS NOT NULL DO UPDATE SET client_key=EXCLUDED.client_key
		RETURNING id`, databaseSafeText(filename), userID, bookID, key, batchID).Scan(&jobID)
	if err != nil {
		return 0, err
	}
	return jobID, s.completeImportBatchIfReady(ctx, &batchID)
}
