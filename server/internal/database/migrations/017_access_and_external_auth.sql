ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users
    ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'
        CHECK (auth_source IN ('local', 'oidc', 'ldap')),
    ADD COLUMN external_subject TEXT;

CREATE UNIQUE INDEX users_external_identity_unique
    ON users(auth_source, external_subject)
    WHERE external_subject IS NOT NULL;

CREATE TABLE book_file_permissions (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_file_id BIGINT NOT NULL REFERENCES book_files(id) ON DELETE CASCADE,
    can_read BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, book_file_id)
);

CREATE INDEX book_file_permissions_book_idx
    ON book_file_permissions(book_file_id, user_id);
