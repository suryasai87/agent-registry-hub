"""Notification outbox.

Every notification is written as an in-app row (the inbox). When an email/webhook dispatcher is configured
(``NOTIFY_WEBHOOK_URL``), a second row with channel ``email`` is queued and the dispatcher records the real
delivery status. Nothing is ever marked "sent" without a delivery attempt.
"""
from __future__ import annotations

import os


def webhook_url() -> str:
    """The relay URL, or "" when unset ("none" is the bundle's sentinel: Apps reject empty env values)."""
    url = os.environ.get("NOTIFY_WEBHOOK_URL", "").strip()
    return "" if url.lower() in ("", "none") else url


def webhook_configured() -> bool:
    return bool(webhook_url())


def queue(cur, recipient_email: str, kind: str, title: str, body: str | None = None,
          asset_id: str | None = None, ref_id: str | int | None = None) -> int:
    """Queue one notification for ``recipient_email``. Returns the number of rows written."""
    email = (recipient_email or "").strip().lower()
    if "@" not in email:
        return 0
    rows = [("in_app", "sent")]
    if webhook_configured():
        rows.append(("email", "queued"))
    for channel, status in rows:
        cur.execute(
            """
            INSERT INTO notification (recipient_email, kind, title, body, asset_id, ref_id, channel, delivery_status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (email, kind, title[:300], body, asset_id, None if ref_id is None else str(ref_id), channel, status),
        )
    return len(rows)
