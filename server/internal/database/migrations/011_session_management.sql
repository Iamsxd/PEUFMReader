ALTER TABLE user_sessions
    ADD COLUMN id BIGSERIAL;

ALTER TABLE user_sessions
    ADD CONSTRAINT user_sessions_id_unique UNIQUE (id);
