CREATE INDEX reading_sessions_user_started_idx
    ON reading_sessions(user_id, started_at DESC)
    INCLUDE (book_file_id, active_seconds);
