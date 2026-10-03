CREATE TABLE personal_shelves (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX personal_shelves_user_name_idx ON personal_shelves(user_id, lower(name));
CREATE TABLE personal_shelf_books (
    shelf_id BIGINT NOT NULL REFERENCES personal_shelves(id) ON DELETE CASCADE,
    book_file_id BIGINT NOT NULL REFERENCES book_files(id) ON DELETE CASCADE,
    position BIGINT NOT NULL CHECK (position > 0),
    PRIMARY KEY (shelf_id, book_file_id)
);
CREATE INDEX personal_shelf_books_order_idx ON personal_shelf_books(shelf_id, position, book_file_id);
CREATE INDEX reading_marks_user_updated_idx ON reading_marks(user_id, updated_at DESC, id DESC);
