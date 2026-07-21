CREATE TABLE reading_marks (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_file_id BIGINT NOT NULL REFERENCES book_files(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('bookmark', 'note')),
    position JSONB NOT NULL CHECK (jsonb_typeof(position) = 'object'),
    overall_progress DOUBLE PRECISION NOT NULL CHECK (overall_progress BETWEEN 0 AND 1),
    label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
    body TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 10000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reading_marks_note_body CHECK (kind <> 'note' OR char_length(btrim(body)) > 0)
);

CREATE UNIQUE INDEX reading_marks_bookmark_position_unique
    ON reading_marks(user_id, book_file_id, kind, position)
    WHERE kind = 'bookmark';

CREATE INDEX reading_marks_user_book_idx
    ON reading_marks(user_id, book_file_id, updated_at DESC, id DESC);
