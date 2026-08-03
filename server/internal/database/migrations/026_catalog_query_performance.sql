-- Catalog filtering starts from a permission-filtered set. These indexes keep
-- category and text-metadata existence checks cheap for large libraries.
CREATE INDEX classification_decisions_edition_status_category_idx
    ON classification_decisions(edition_id, status, category_id);

CREATE INDEX book_files_format_created_idx
    ON book_files(format, created_at DESC, id DESC);
