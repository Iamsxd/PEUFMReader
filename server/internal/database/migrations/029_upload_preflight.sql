CREATE INDEX IF NOT EXISTS book_files_managed_size_idx ON book_files(size_bytes) WHERE storage_mode='managed';
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS client_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS import_jobs_batch_client_key_idx ON import_jobs(batch_id,client_key) WHERE client_key IS NOT NULL;
