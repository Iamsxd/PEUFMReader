CREATE TABLE recommendation_feedback (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_file_id BIGINT NOT NULL REFERENCES book_files(id) ON DELETE CASCADE,
    feedback TEXT NOT NULL CHECK (feedback IN ('interested', 'not_interested')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, book_file_id)
);

CREATE INDEX recommendation_feedback_user_kind_idx
    ON recommendation_feedback(user_id, feedback, updated_at DESC);

