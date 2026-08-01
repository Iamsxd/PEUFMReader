ALTER TABLE book_files
    ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'managed'
        CHECK (storage_mode IN ('managed', 'calibre-reference')),
    ADD COLUMN reference_path TEXT,
    ADD COLUMN reference_key TEXT;

ALTER TABLE book_files
    ADD CONSTRAINT book_files_reference_mode_check CHECK (
        (storage_mode = 'managed' AND reference_path IS NULL AND reference_key IS NULL)
        OR (storage_mode = 'calibre-reference' AND reference_path IS NOT NULL AND reference_key IS NOT NULL)
    );

CREATE UNIQUE INDEX book_files_reference_key_unique
    ON book_files(reference_key)
    WHERE reference_key IS NOT NULL;

CREATE INDEX book_files_storage_mode_idx ON book_files(storage_mode, id);
