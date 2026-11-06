"""In-app background worker: access-request sweeps and notification delivery.

Runs every ``SWEEP_INTERVAL_S`` (default 600 s) in a daemon thread. A Postgres advisory lock makes only one
app instance do the work per tick. Each tick:
* ``access.sweep``: day-3 reminders, day-7 request expiry, and revoking expired app-provisioned grants;
* delivers queued ``email`` notifications to ``NOTIFY_WEBHOOK_URL`` (any HTTP relay: Power Automate,
  Logic Apps, a Slack workflow, an SMTP bridge). The real HTTP status is recorded; a failure stays visible as
  ``failed``.
Disable with ``BACKGROUND_WORKER=false``.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import urllib.request

from core import config, db

log = logging.getLogger("registry.background")
LOCK_KEY = 0x5245_4749  # "REGI"
_started = False


def deliver(cur, limit: int = 50) -> dict:
    from registry.notify import webhook_url

    url = webhook_url()
    if not url:
        return {"delivered": 0, "failed": 0}
    cur.execute("""SELECT notification_id, recipient_email, kind, title, body, asset_id, ref_id FROM notification
                    WHERE channel = 'email' AND delivery_status = 'queued' ORDER BY created_at LIMIT %s FOR UPDATE SKIP LOCKED""", (limit,))
    ok = failed = 0
    base = os.environ.get("APP_URL", "").rstrip("/")
    for n in cur.fetchall():
        link = f"{base}/assets/{n['asset_id']}" if base and n["asset_id"] else base or None
        payload = json.dumps({"to": n["recipient_email"], "subject": n["title"], "body": n["body"] or "", "kind": n["kind"],
                              "asset_id": n["asset_id"], "ref_id": n["ref_id"], "link": link}).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                status, detail = ("sent", f"HTTP {resp.status}") if 200 <= resp.status < 300 else ("failed", f"HTTP {resp.status}")
        except Exception as e:  # noqa: BLE001 - recorded on the row
            status, detail = "failed", f"{type(e).__name__}: {str(e)[:200]}"
        cur.execute("UPDATE notification SET delivery_status = %s, delivery_detail = %s WHERE notification_id = %s",
                    (status, detail, n["notification_id"]))
        ok += status == "sent"
        failed += status == "failed"
    return {"delivered": ok, "failed": failed}


def tick() -> dict | None:
    if not config.ALLOW_MUTATIONS:
        return None
    from registry import access

    with db.transaction() as cur:
        cur.execute("SELECT pg_try_advisory_xact_lock(%s) AS got", (LOCK_KEY,))
        if not cur.fetchone()["got"]:
            return None
        result = {**access.sweep(cur), **deliver(cur)}
        cur.execute("SELECT to_regclass('update_candidate') IS NOT NULL AS ok")
        if cur.fetchone()["ok"]:
            from registry import platform_watch
            result["updates_resurfaced"] = platform_watch.resurface_delayed(cur)
    if any(result.values()):
        log.info("background tick: %s", result)
    return result


def start() -> None:
    global _started
    if _started or os.environ.get("BACKGROUND_WORKER", "true").strip().lower() in ("0", "false", "no", "off"):
        return
    _started = True
    interval = float(os.environ.get("SWEEP_INTERVAL_S", "600"))
    stop = threading.Event()

    def loop():
        while not stop.wait(interval):
            try:
                tick()
            except Exception:  # noqa: BLE001 - the next tick retries; reads never depend on this thread
                log.warning("background tick failed", exc_info=True)

    threading.Thread(target=loop, name="registry-background", daemon=True).start()
    threading.Thread(target=_record_version, name="registry-version", daemon=True).start()


def _record_version() -> None:
    """Platform Watch compares the staged bundle VERSION with the running one (watch_settings.running_version)."""
    try:
        from registry import platform_watch
        with db.transaction() as cur:
            cur.execute("SELECT to_regclass('watch_settings') IS NOT NULL AS ok")
            if cur.fetchone()["ok"]:
                platform_watch.record_running_version(cur, config.APP_VERSION)
    except Exception:  # noqa: BLE001 - informational; never blocks startup
        log.info("could not record the running version", exc_info=True)
