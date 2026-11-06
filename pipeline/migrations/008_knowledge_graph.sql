-- The knowledge graph export (registry/knowledge_graph.py + registry/kg_delta.py): the registry as RDF triples,
-- materialised as Unity Catalog Delta objects in the OntoBricks layout for Genie agents and OntoBricks.
-- Additive only (one new table and one seed setting), so Platform Watch treats the release as non-breaking.
--
-- * kg_export_run: every export (admin or the sync job step), with the digest it wrote. The sync step's cheap
--   "unchanged" check compares the current digest with the last successful run for the same target, so an unchanged
--   registry costs no warehouse time. The UC objects carry the same digest in TBLPROPERTIES (kg_digest).
-- * kg_export_in_sync: the sync job's optional export step, OFF until an admin turns it on (audited, like
--   uc_lineage_publish_in_sync). Target catalog / schema / version settings default to the bundle variable kg_target.

CREATE TABLE IF NOT EXISTS {{schema}}.kg_export_run (
    run_id        bigserial PRIMARY KEY,
    triggered_by  text NOT NULL,                    -- the admin's email, or system:sync for the job step
    mode          text NOT NULL CHECK (mode IN ('platform','record_only')),
    acting_as     text,                             -- approver (on-behalf-of) | app service principal | sync job identity
    target        text NOT NULL,                    -- catalog.schema.triplestore_agent_registry_hub_V<n>
    digest        text NOT NULL,                    -- layout + namespace + target + install id + every triple
    status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','succeeded','unchanged','conflict','failed')),
    counts        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- triples, classes, predicates, batches, objects, statements
    conflicts     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- target names taken by objects the hub did not create (left untouched)
    error         text,
    statements    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- the SQL run (platform) or recorded (record_only); INSERT batches summarised
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS kg_export_run_target_idx ON {{schema}}.kg_export_run (target, run_id DESC);

INSERT INTO {{schema}}.registry_setting (key, value) VALUES
    ('kg_export_in_sync', 'false')
ON CONFLICT DO NOTHING;
