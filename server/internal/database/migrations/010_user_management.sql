ALTER TABLE user_sessions
    ADD COLUMN created_ip TEXT NOT NULL DEFAULT '',
    ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';

ALTER TABLE import_jobs
    DROP CONSTRAINT IF EXISTS import_jobs_created_by_fkey;

ALTER TABLE import_jobs
    ALTER COLUMN created_by DROP NOT NULL,
    ADD CONSTRAINT import_jobs_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX user_sessions_active_user_idx
    ON user_sessions(user_id, expires_at DESC);
