CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX reading_states_user_updated_idx
    ON reading_states(user_id, updated_at DESC);
CREATE INDEX reading_states_user_status_updated_idx
    ON reading_states(user_id, status, updated_at DESC);
CREATE INDEX reading_sessions_started_book_user_idx
    ON reading_sessions(started_at DESC, book_file_id, user_id)
    INCLUDE (active_seconds);
CREATE INDEX book_files_created_idx
    ON book_files(created_at DESC, id DESC);
CREATE INDEX classification_decisions_category_status_edition_idx
    ON classification_decisions(category_id, status, edition_id);
CREATE INDEX edition_creators_edition_role_position_idx
    ON edition_creators(edition_id, role, position);

CREATE INDEX works_title_trgm_idx
    ON works USING gin (lower(title) gin_trgm_ops);
CREATE INDEX creators_name_trgm_idx
    ON creators USING gin (lower(name) gin_trgm_ops);
CREATE INDEX book_files_filename_trgm_idx
    ON book_files USING gin (lower(original_filename) gin_trgm_ops);
