-- A durable receipt makes retries safe even after a mark has been deleted.
CREATE TABLE reading_mark_sync_receipts (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id UUID NOT NULL,
    book_file_id BIGINT NOT NULL REFERENCES book_files(id) ON DELETE CASCADE,
    mark_id BIGINT NOT NULL,
    request_hash TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, operation_id)
);
CREATE INDEX reading_mark_sync_receipts_mark_idx ON reading_mark_sync_receipts(user_id,mark_id);
-- Retain only an idempotency tombstone after deletion, never the deleted quote
-- or note body. Also applies to legacy delete endpoints and book cascades.
CREATE FUNCTION scrub_deleted_mark_receipts() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    UPDATE reading_mark_sync_receipts SET result='{"deleted":true}'::jsonb
    WHERE user_id=OLD.user_id AND mark_id=OLD.id;
    RETURN OLD;
END $$;
CREATE TRIGGER reading_mark_delete_receipts AFTER DELETE ON reading_marks
    FOR EACH ROW EXECUTE FUNCTION scrub_deleted_mark_receipts();
