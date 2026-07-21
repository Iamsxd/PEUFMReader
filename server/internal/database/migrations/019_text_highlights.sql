ALTER TABLE reading_marks
    DROP CONSTRAINT reading_marks_kind_check;

ALTER TABLE reading_marks
    ADD COLUMN quote TEXT NOT NULL DEFAULT '' CHECK (char_length(quote) <= 4000),
    ADD COLUMN color TEXT NOT NULL DEFAULT '' CHECK (color IN ('', 'yellow', 'green', 'blue', 'pink', 'purple')),
    ADD CONSTRAINT reading_marks_kind_check CHECK (kind IN ('bookmark', 'note', 'highlight')),
    ADD CONSTRAINT reading_marks_highlight_quote CHECK (kind <> 'highlight' OR char_length(btrim(quote)) > 0),
    ADD CONSTRAINT reading_marks_highlight_color CHECK (kind <> 'highlight' OR color <> '');

