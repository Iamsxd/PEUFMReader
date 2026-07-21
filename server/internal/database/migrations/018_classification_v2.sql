INSERT INTO categories(slug,name,parent_id,active,system)
SELECT 'chinese-classics','中国古典与国学',id,true,true FROM categories WHERE slug='classics'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO categories(slug,name,parent_id,active,system)
SELECT 'interpersonal-communication','人际关系与沟通',id,true,true FROM categories WHERE slug='psychology'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO categories(slug,name,parent_id,active,system)
SELECT 'minimalist-living','极简生活',id,true,true FROM categories WHERE slug='lifestyle'
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE classification_rules
    ADD COLUMN strong_keywords TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN customized BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN default_version INTEGER NOT NULL DEFAULT 1;

UPDATE classification_rules
SET customized = updated_at > created_at + interval '1 second';

ALTER TABLE classification_rules
    ADD CONSTRAINT classification_rules_strong_keyword_limit CHECK (cardinality(strong_keywords) <= 200);
