package store

import (
	"context"
	"fmt"
)

type StorageRecord struct {
	BookFileID int64
	Path       string
	SizeBytes  int64
	SHA256     []byte
}

func (s *Store) ListStorageRecords(ctx context.Context) ([]StorageRecord, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,storage_path,size_bytes,sha256 FROM book_files ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("list storage records: %w", err)
	}
	defer rows.Close()
	records := make([]StorageRecord, 0)
	for rows.Next() {
		var record StorageRecord
		if err := rows.Scan(&record.BookFileID, &record.Path, &record.SizeBytes, &record.SHA256); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}
