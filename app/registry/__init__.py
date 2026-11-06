"""Domain services shared by the HTTP modules (app/modules/*) and the collectors (app/collectors/*).

Every function takes an open psycopg dict-row cursor (``with db.transaction() as cur``), so callers decide
the transaction boundary and the audit row commits together with the change it describes.
Lakebase connections set ``search_path`` to the registry schema, so the SQL here is unqualified.

Lineage edge direction: ``src_id`` USES / DEPENDS ON ``dst_id`` (agent → tool, user → agent, tool → table).
"Upstream" of X = what X depends on (follow outgoing edges); "downstream" = who depends on X (incoming).
"""
