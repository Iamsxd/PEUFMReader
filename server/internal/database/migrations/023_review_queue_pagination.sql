CREATE INDEX works_pending_review_order_idx
    ON works(updated_at, id)
    WHERE review_status = 'pending';

CREATE INDEX classification_decisions_suggested_edition_idx
    ON classification_decisions(edition_id)
    WHERE status = 'suggested';

CREATE INDEX book_files_format_edition_idx
    ON book_files(format, edition_id, id);
