ALTER TABLE personal_shelves ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','smart'));
ALTER TABLE personal_shelves ADD COLUMN rules JSONB;
ALTER TABLE personal_shelves ADD CONSTRAINT personal_shelves_rules_check CHECK (
    (kind='manual' AND rules IS NULL) OR (kind='smart' AND jsonb_typeof(rules)='object')
);

-- Materialize access once for all of a user's shelves, not once per book.
CREATE FUNCTION personal_shelf_visible_members(request_user_id BIGINT)
RETURNS TABLE(shelf_id BIGINT, book_file_id BIGINT, "position" BIGINT)
LANGUAGE SQL STABLE AS $$
    WITH allowed AS MATERIALIZED (SELECT book_file_id FROM accessible_book_ids(request_user_id)),
    owned AS MATERIALIZED (SELECT * FROM personal_shelves WHERE user_id=request_user_id)
    SELECT ps.id,sb.book_file_id,sb.position FROM owned ps
    JOIN personal_shelf_books sb ON sb.shelf_id=ps.id JOIN allowed a USING(book_file_id)
    WHERE ps.kind='manual'
    UNION ALL
    SELECT ps.id,bf.id,ROW_NUMBER() OVER(PARTITION BY ps.id ORDER BY w.sort_title,bf.id)
    FROM owned ps CROSS JOIN allowed a JOIN book_files bf ON bf.id=a.book_file_id
    JOIN editions e ON e.id=bf.edition_id JOIN works w ON w.id=e.work_id
    LEFT JOIN reading_states rs ON rs.user_id=request_user_id AND rs.book_file_id=bf.id
    WHERE ps.kind='smart'
        AND (COALESCE(ps.rules->>'format','')='' OR bf.format=ps.rules->>'format')
        AND (COALESCE(ps.rules->>'status','')='' OR COALESCE(rs.status,'unread')=ps.rules->>'status')
        AND (COALESCE(ps.rules->>'favorite','')<>'true' OR EXISTS(
            SELECT 1 FROM user_favorites f WHERE f.user_id=request_user_id AND f.book_file_id=bf.id))
        AND (COALESCE(ps.rules->>'categorySlug','')='' OR EXISTS(
            SELECT 1 FROM classification_decisions cd JOIN categories c ON c.id=cd.category_id
            WHERE cd.edition_id=e.id AND cd.status='accepted' AND c.slug=ps.rules->>'categorySlug'))
$$;
