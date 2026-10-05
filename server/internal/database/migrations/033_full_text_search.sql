CREATE TABLE search_documents (
    book_file_id BIGINT PRIMARY KEY REFERENCES book_files(id) ON DELETE CASCADE,
    source_hash BYTEA NOT NULL,
    text_path TEXT NOT NULL DEFAULT '',
    text_method TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL,
    coverage TEXT NOT NULL,
    passage_count INTEGER NOT NULL,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE search_passages (
    book_file_id BIGINT NOT NULL REFERENCES search_documents(book_file_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    label TEXT NOT NULL,
    position JSONB NOT NULL,
    body TEXT NOT NULL CHECK (char_length(body)<=2000),
    PRIMARY KEY(book_file_id,ordinal)
);
CREATE INDEX search_passages_body_trgm_idx ON search_passages USING gin(lower(body) gin_trgm_ops);
