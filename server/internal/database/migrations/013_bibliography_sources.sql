CREATE TABLE bibliography_sources (
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    base_url TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
    timeout_ms INTEGER NOT NULL DEFAULT 8000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
    max_results INTEGER NOT NULL DEFAULT 5 CHECK (max_results BETWEEN 1 AND 20),
    auto_search BOOLEAN NOT NULL DEFAULT FALSE,
    last_checked_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_latency_ms INTEGER CHECK (last_latency_ms IS NULL OR last_latency_ms >= 0),
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX bibliography_sources_enabled_priority_idx
    ON bibliography_sources(enabled, priority, provider);
