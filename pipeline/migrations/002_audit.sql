-- Append-only, hash-chained audit trail.
-- Every governed change (grant, request decision, description edit, override, publish, pause,
-- subscription, role change) writes one row. Rows can't be updated or deleted (the triggers raise).
-- Each row carries sha256(prev_hash || canonical row), so any edit made outside the app is detectable
-- with {{schema}}.verify_audit_chain().

CREATE TABLE IF NOT EXISTS {{schema}}.audit_log (
    audit_id     bigserial PRIMARY KEY,
    at           timestamptz NOT NULL DEFAULT now(),
    actor        text NOT NULL,
    action       text NOT NULL,
    entity_type  text NOT NULL,
    entity_id    text,
    before       jsonb,
    after        jsonb,
    request_id   text,
    reason       text,
    source       text NOT NULL DEFAULT 'ui',     -- ui, api, sync, job
    prev_hash    text,
    row_hash     text
);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON {{schema}}.audit_log (entity_type, entity_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx  ON {{schema}}.audit_log (actor, at DESC);

CREATE OR REPLACE FUNCTION {{schema}}.audit_canonical(r {{schema}}.audit_log) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT concat_ws('|',
        r.audit_id::text,
        to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        r.actor, r.action, r.entity_type, coalesce(r.entity_id, ''),
        coalesce(r.before::text, ''), coalesce(r.after::text, ''),
        coalesce(r.request_id, ''), coalesce(r.reason, ''), r.source,
        coalesce(r.prev_hash, ''))
$$;

CREATE OR REPLACE FUNCTION {{schema}}.audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- serialise writers so the chain is linear
    PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || '.audit_log'));
    EXECUTE format('SELECT row_hash FROM %I.audit_log ORDER BY audit_id DESC LIMIT 1', TG_TABLE_SCHEMA)
       INTO NEW.prev_hash;
    NEW.at := coalesce(NEW.at, now());
    NEW.row_hash := encode(sha256(convert_to({{schema}}.audit_canonical(NEW), 'UTF8')), 'hex');
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION {{schema}}.audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS audit_log_chain ON {{schema}}.audit_log;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON {{schema}}.audit_log
    FOR EACH ROW EXECUTE FUNCTION {{schema}}.audit_chain();

DROP TRIGGER IF EXISTS audit_log_no_update ON {{schema}}.audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON {{schema}}.audit_log
    FOR EACH ROW EXECUTE FUNCTION {{schema}}.audit_immutable();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON {{schema}}.audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON {{schema}}.audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.audit_immutable();

-- Returns one row per broken link (empty = the chain is intact).
CREATE OR REPLACE FUNCTION {{schema}}.verify_audit_chain()
RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    r {{schema}}.audit_log;
    expected_prev text := NULL;
BEGIN
    FOR r IN SELECT * FROM {{schema}}.audit_log ORDER BY audit_log.audit_id LOOP
        IF coalesce(r.prev_hash, '') <> coalesce(expected_prev, '') THEN
            audit_id := r.audit_id; problem := 'prev_hash does not match the previous row'; RETURN NEXT;
        END IF;
        IF r.row_hash <> encode(sha256(convert_to({{schema}}.audit_canonical(r), 'UTF8')), 'hex') THEN
            audit_id := r.audit_id; problem := 'row_hash does not match the row content'; RETURN NEXT;
        END IF;
        expected_prev := r.row_hash;
    END LOOP;
END $$;
