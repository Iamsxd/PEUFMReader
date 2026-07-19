ALTER TABLE works
    ADD COLUMN description TEXT,
    ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending', 'reviewed'));

ALTER TABLE editions
    ADD COLUMN publisher TEXT,
    ADD COLUMN source_subjects TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE book_files
    ADD COLUMN cover_path TEXT;

ALTER TABLE import_jobs
    ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE creators (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    sort_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE edition_creators (
    edition_id BIGINT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    creator_id BIGINT NOT NULL REFERENCES creators(id) ON DELETE RESTRICT,
    role TEXT NOT NULL DEFAULT 'author' CHECK (role IN ('author', 'translator', 'editor')),
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    PRIMARY KEY (edition_id, creator_id, role)
);
CREATE INDEX edition_creators_creator_idx ON edition_creators(creator_id, edition_id);

CREATE TABLE categories (
    id BIGSERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    parent_id BIGINT REFERENCES categories(id) ON DELETE RESTRICT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO categories(slug, name) VALUES
    ('literature', '文学'),
    ('science-fiction', '科幻'),
    ('fantasy', '奇幻'),
    ('mystery', '悬疑推理'),
    ('romance', '爱情'),
    ('history', '历史'),
    ('biography', '传记'),
    ('business', '商业与经济'),
    ('technology', '技术与计算机'),
    ('science', '自然科学'),
    ('philosophy', '哲学'),
    ('social-sciences', '社会科学'),
    ('art', '艺术'),
    ('children', '少儿'),
    ('education', '教育'),
    ('health', '健康'),
    ('travel', '旅行'),
    ('reference', '工具书'),
    ('other', '其他');

CREATE TABLE metadata_candidates (
    id BIGSERIAL PRIMARY KEY,
    edition_id BIGINT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL,
    value JSONB NOT NULL,
    source TEXT NOT NULL,
    confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'accepted'
        CHECK (status IN ('suggested', 'accepted', 'rejected', 'superseded')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX metadata_candidates_edition_idx ON metadata_candidates(edition_id, status, field_name);

CREATE TABLE classification_decisions (
    id BIGSERIAL PRIMARY KEY,
    edition_id BIGINT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    source TEXT NOT NULL,
    confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'suggested'
        CHECK (status IN ('suggested', 'accepted', 'rejected')),
    decided_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (edition_id, category_id, source)
);
CREATE INDEX classification_decisions_review_idx ON classification_decisions(status, edition_id);
