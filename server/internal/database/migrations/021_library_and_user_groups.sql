CREATE TABLE user_groups (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_groups_name_unique ON user_groups(lower(name));

CREATE TABLE user_group_members (
    user_group_id BIGINT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_group_id, user_id)
);

CREATE INDEX user_group_members_user_idx ON user_group_members(user_id, user_group_id);

CREATE TABLE library_groups (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
    default_access BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX library_groups_name_unique ON library_groups(lower(name));

CREATE TABLE library_group_books (
    library_group_id BIGINT NOT NULL REFERENCES library_groups(id) ON DELETE CASCADE,
    book_file_id BIGINT NOT NULL REFERENCES book_files(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (library_group_id, book_file_id)
);

CREATE INDEX library_group_books_book_idx ON library_group_books(book_file_id, library_group_id);

CREATE TABLE user_group_library_permissions (
    user_group_id BIGINT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    library_group_id BIGINT NOT NULL REFERENCES library_groups(id) ON DELETE CASCADE,
    can_read BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_group_id, library_group_id)
);

CREATE INDEX user_group_library_permissions_library_idx
    ON user_group_library_permissions(library_group_id, user_group_id);

CREATE OR REPLACE FUNCTION can_user_read_book(p_user_id BIGINT, p_book_file_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN account.role = 'admin' THEN true
        WHEN direct_permission.can_read IS NOT NULL THEN direct_permission.can_read
        WHEN EXISTS (
            SELECT 1
            FROM library_group_books membership
            JOIN user_group_library_permissions permission
              ON permission.library_group_id = membership.library_group_id
             AND permission.can_read = false
            JOIN user_group_members reader_group
              ON reader_group.user_group_id = permission.user_group_id
             AND reader_group.user_id = account.id
            WHERE membership.book_file_id = p_book_file_id
        ) THEN false
        WHEN EXISTS (
            SELECT 1
            FROM library_group_books membership
            JOIN user_group_library_permissions permission
              ON permission.library_group_id = membership.library_group_id
             AND permission.can_read = true
            JOIN user_group_members reader_group
              ON reader_group.user_group_id = permission.user_group_id
             AND reader_group.user_id = account.id
            WHERE membership.book_file_id = p_book_file_id
        ) THEN true
        WHEN EXISTS (
            SELECT 1
            FROM library_group_books membership
            JOIN library_groups library_group ON library_group.id = membership.library_group_id
            WHERE membership.book_file_id = p_book_file_id
              AND library_group.default_access = false
        ) THEN false
        ELSE true
    END
    FROM users account
    JOIN book_files book ON book.id = p_book_file_id
    LEFT JOIN book_file_permissions direct_permission
      ON direct_permission.user_id = account.id
     AND direct_permission.book_file_id = book.id
    WHERE account.id = p_user_id
      AND account.disabled_at IS NULL;
$$;
