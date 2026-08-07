CREATE TABLE import_batches (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    total_items INTEGER NOT NULL CHECK (total_items > 0),
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

ALTER TABLE import_jobs
    ADD COLUMN batch_id BIGINT REFERENCES import_batches(id) ON DELETE CASCADE,
    ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome IN ('imported', 'duplicate', 'failed'));

UPDATE import_jobs
SET outcome = CASE
    WHEN state = 'failed' THEN 'failed'
    WHEN state = 'completed' THEN 'imported'
    ELSE NULL
END
WHERE outcome IS NULL;

CREATE INDEX import_batches_created_idx ON import_batches(created_at DESC, id DESC);
CREATE INDEX import_jobs_batch_created_idx ON import_jobs(batch_id, created_at, id);
