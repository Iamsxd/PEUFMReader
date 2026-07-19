CREATE TABLE audit_events (
    id BIGSERIAL PRIMARY KEY,
    actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    client_ip TEXT NOT NULL DEFAULT '',
    status_code INTEGER NOT NULL CHECK (status_code BETWEEN 100 AND 599),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC, id DESC);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;

