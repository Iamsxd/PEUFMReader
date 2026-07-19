CREATE TABLE user_favorites (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_file_id BIGINT NOT NULL REFERENCES book_files(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, book_file_id)
);

CREATE INDEX user_favorites_user_created_idx
    ON user_favorites(user_id, created_at DESC, book_file_id);
CREATE INDEX user_favorites_book_idx
    ON user_favorites(book_file_id, user_id);
