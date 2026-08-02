CREATE INDEX classification_decisions_accepted_edition_category_idx
    ON classification_decisions(edition_id, category_id)
    WHERE status = 'accepted';

CREATE INDEX edition_creators_author_edition_creator_idx
    ON edition_creators(edition_id, creator_id)
    WHERE role = 'author';
