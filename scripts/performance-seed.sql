INSERT INTO works(title, sort_title, description, review_status)
SELECT 'Performance Book ' || value, lower('Performance Book ' || value), 'Synthetic performance baseline record', 'reviewed'
FROM generate_series(1, 3000) AS value;

INSERT INTO editions(work_id, language, published_year, publisher, source_subjects)
SELECT id, CASE WHEN id % 3 = 0 THEN 'zh' ELSE 'en' END, 1980 + (id % 46), 'Performance Publisher', ARRAY['technology']
FROM works;

INSERT INTO creators(name, sort_name, normalized_name)
SELECT 'Performance Author ' || value, 'performance author ' || value, 'performance author ' || value
FROM generate_series(1, 50) AS value;

INSERT INTO edition_creators(edition_id, creator_id, role, position)
SELECT e.id, ((e.id - 1) % 50) + 1, 'author', 0
FROM editions e;

INSERT INTO book_files(edition_id, original_filename, storage_path, sha256, format, mime_type, size_bytes)
SELECT e.id,
       'performance-' || e.id || '.epub',
       'perf/' || e.id || '.epub',
       decode(md5(e.id::text) || md5('performance-' || e.id), 'hex'),
       'epub', 'application/epub+zip', 20971520
FROM editions e;

INSERT INTO classification_decisions(edition_id, category_id, source, confidence, reason, status)
SELECT e.id, c.id, 'performance-seed', 0.99, 'Synthetic performance baseline', 'accepted'
FROM editions e
CROSS JOIN categories c
WHERE c.slug = 'technology';

ANALYZE;

