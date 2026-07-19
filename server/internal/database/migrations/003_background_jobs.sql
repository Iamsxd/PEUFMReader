CREATE TABLE background_jobs (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'running', 'completed', 'failed')),
    dedupe_key TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_by TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_error TEXT,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    book_file_id BIGINT REFERENCES book_files(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX background_jobs_active_dedupe_idx
    ON background_jobs(kind, dedupe_key)
    WHERE state IN ('queued', 'running');
CREATE INDEX background_jobs_claim_idx
    ON background_jobs(state, available_at, created_at)
    WHERE state = 'queued';
CREATE INDEX background_jobs_book_idx ON background_jobs(book_file_id, created_at DESC);
