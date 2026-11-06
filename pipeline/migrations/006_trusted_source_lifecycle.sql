-- Databricks-native assets are already governed by Unity Catalog and workspace ACLs: register them as approved.
-- External and custom assets (third-party MCP connections, custom MCP apps and their tools) stay 'discovered' for
-- steward review. One audited bulk change; collectors apply the same rule to new assets (upserts.initial_lifecycle).
WITH changed AS (
    UPDATE {{schema}}.asset SET lifecycle_status = 'approved', updated_at = now()
     WHERE lifecycle_status = 'discovered' AND source = 'databricks' AND origin = 'sync'
    RETURNING asset_id
)
INSERT INTO {{schema}}.audit_log (actor, action, entity_type, entity_id, after, reason, source)
SELECT 'system:migration', 'curation.auto_approve_platform', 'asset', 'bulk',
       jsonb_build_object('count', count(*), 'rule', 'source = databricks'),
       'Databricks-native assets are governed by Unity Catalog / workspace ACLs (migration 006)', 'job'
  FROM changed;
