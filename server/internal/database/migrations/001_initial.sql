CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'reader')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    disabled_at TIMESTAMPTZ,
    CONSTRAINT users_username_normalized CHECK (username = lower(username)),
    CONSTRAINT users_username_unique UNIQUE (username)
);

CREATE TABLE user_sessions (
    token_hash BYTEA PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_user_id_idx ON user_sessions(user_id);
CREATE INDEX user_sessions_expires_at_idx ON user_sessions(expires_at);

CREATE TABLE works (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    sort_title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE editions (
    id BIGSERIAL PRIMARY KEY,
    work_id BIGINT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    isbn TEXT,
    language TEXT,
    published_year INTEGER CHECK (published_year IS NULL OR published_year BETWEEN 0 AND 9999),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE book_files (
    id BIGSERIAL PRIMARY KEY,
    edition_id BIGINT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    original_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL UNIQUE,
    sha256 BYTEA NOT NULL UNIQUE,
    format TEXT NOT NULL CHECK (format IN ('pdf', 'epub')),
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX book_files_edition_id_idx ON book_files(edition_id);

CREATE TABLE reading_states (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_file_id BIGINT NOT NULL REFERENCES book_files(id) ON DELETE CASCADE,
    position JSONB NOT NULL DEFAULT '{}'::jsonb,
    overall_progress DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (overall_progress BETWEEN 0 AND 1),
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'reading', 'finished', 'paused', 'abandoned')),
    total_active_seconds BIGINT NOT NULL DEFAULT 0 CHECK (total_active_seconds >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, book_file_id)
);

CREATE TABLE reading_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_file_id BIGINT NOT NULL REFERENCES book_files(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    active_seconds BIGINT NOT NULL DEFAULT 0 CHECK (active_seconds >= 0)
);
CREATE INDEX reading_sessions_user_book_idx ON reading_sessions(user_id, book_file_id, started_at DESC);

CREATE TABLE import_jobs (
    id BIGSERIAL PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
    source_name TEXT NOT NULL,
    error_message TEXT,
    book_file_id BIGINT REFERENCES book_files(id) ON DELETE SET NULL,
    created_by BIGINT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
