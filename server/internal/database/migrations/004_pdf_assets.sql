ALTER TABLE book_files
    ADD COLUMN extracted_text_path TEXT,
    ADD COLUMN text_extraction_method TEXT
        CHECK (text_extraction_method IS NULL OR text_extraction_method IN ('embedded', 'ocr')),
    ADD COLUMN page_count INTEGER CHECK (page_count IS NULL OR page_count > 0),
    ADD COLUMN assets_updated_at TIMESTAMPTZ;
