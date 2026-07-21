CREATE TABLE classification_rules (
    id BIGSERIAL PRIMARY KEY,
    category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    keywords TEXT[] NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true,
    priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 10000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT classification_rules_category_unique UNIQUE (category_id),
    CONSTRAINT classification_rules_keyword_limit CHECK (cardinality(keywords) <= 200)
);

CREATE INDEX classification_rules_enabled_priority_idx
    ON classification_rules(enabled, priority, id);
