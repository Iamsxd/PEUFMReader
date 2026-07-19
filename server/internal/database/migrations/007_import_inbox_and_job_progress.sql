ALTER TABLE background_jobs
    ADD COLUMN progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    ADD COLUMN progress_message TEXT NOT NULL DEFAULT '';

