CREATE TABLE device_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    token_hash BYTEA NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX device_tokens_user_active_idx ON device_tokens(user_id, created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE external_reading_progress (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('koreader', 'kobo', 'generic')),
    document_key TEXT NOT NULL CHECK (char_length(document_key) BETWEEN 1 AND 512),
    book_file_id BIGINT REFERENCES book_files(id) ON DELETE SET NULL,
    locator TEXT NOT NULL DEFAULT '' CHECK (char_length(locator) <= 4096),
    percentage DOUBLE PRECISION NOT NULL CHECK (percentage BETWEEN 0 AND 1),
    device TEXT NOT NULL DEFAULT '' CHECK (char_length(device) <= 200),
    device_id TEXT NOT NULL DEFAULT '' CHECK (char_length(device_id) <= 200),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, provider, document_key)
);

CREATE INDEX external_progress_user_book_idx ON external_reading_progress(user_id, book_file_id, updated_at DESC);
