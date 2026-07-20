ALTER TABLE book_files
    DROP CONSTRAINT IF EXISTS book_files_format_check;

ALTER TABLE book_files
    ADD CONSTRAINT book_files_format_check
        CHECK (format IN ('pdf', 'epub', 'mobi', 'azw3'));
