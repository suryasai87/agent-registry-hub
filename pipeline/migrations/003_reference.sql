-- Reference data: the controls each risk tier requires. This drives the policy coverage meter
-- and the pre-publish checks. Stewards can extend it. Inserts are idempotent.

INSERT INTO {{schema}}.policy_requirement (risk_tier, asset_type, requirement, label)
SELECT t.tier, a.asset_type, r.requirement, r.label
FROM (VALUES ('low',1),('medium',2),('high',3),('critical',4)) AS t(tier, lvl)
CROSS JOIN (VALUES ('agent'),('mcp_server')) AS a(asset_type)
JOIN (VALUES
        ('owner',             'Has an accountable owner',                         1),
        ('purpose',           'Purpose is documented',                            1),
        ('support_channel',   'Support channel is published',                     2),
        ('usage_tracking',    'Usage tracking is on (Unity AI Gateway)',          2),
        ('rate_limit',        'Rate limit is configured',                         2),
        ('guardrail:input',   'Input guardrail (safety / sensitive data)',        3),
        ('guardrail:output',  'Output guardrail (safety / sensitive data)',       3),
        ('inference_logging', 'Payload logging (inference table) is on',          3),
        ('budget',            'Monthly budget with an alert',                     3),
        ('approval',          'Human approval (ASK) on write/destructive tools',  4),
        ('certified',         'Certified by a steward',                           4)
     ) AS r(requirement, label, min_lvl) ON t.lvl >= r.min_lvl
ON CONFLICT DO NOTHING;

INSERT INTO {{schema}}.policy_requirement (risk_tier, asset_type, requirement, label)
SELECT t.tier, a.asset_type, r.requirement, r.label
FROM (VALUES ('low',1),('medium',2),('high',3),('critical',4)) AS t(tier, lvl)
CROSS JOIN (VALUES ('tool'),('skill')) AS a(asset_type)
JOIN (VALUES
        ('owner',           'Has an accountable owner',     1),
        ('purpose',         'Purpose is documented',        1),
        ('support_channel', 'Support channel is published', 3)
     ) AS r(requirement, label, min_lvl) ON t.lvl >= r.min_lvl
ON CONFLICT DO NOTHING;
