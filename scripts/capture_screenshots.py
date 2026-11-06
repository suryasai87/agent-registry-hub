"""Capture the documentation screenshots (docs/screenshots/*.png) from a running local app.

    uv run --with playwright --index-url https://pypi.org/simple/ \
        python scripts/capture_screenshots.py --demo http://localhost:8765 --real http://localhost:8766

``--demo`` serves the fictional demo fleet (agent-centric pages), ``--real`` the live-workspace sync (only
customer-neutral views: Databricks-provided MCP servers and Platform Watch). Uses the installed Chrome. Shots 24-26 need
the extended demo fleet (``demo_seed.seed_extended``) and the Agent 365 fixture imported
(tests/fixtures/agent365/m365_all_agents_export.csv), signed in as an admin.
"""
from __future__ import annotations

import argparse
from pathlib import Path
from urllib.parse import quote

OUT = Path(__file__).resolve().parents[1] / "docs" / "screenshots"
SUP = quote("agent:endpoint:demo-care-supervisor", safe="")
M365 = quote("mcp:system:system.ai.microsoft_365", safe="")
GENIE = quote("agent:genie:demo-claims", safe="")
CARE_MCP = quote("mcp:service:demo.care_tools.care_ops_mcp", safe="")

# Optional interaction steps after the page loads: ("click", button name) · ("fill", field label, value) ·
# ("wait", text) · ("scroll", text).
EDIT_SELECTION = [("click", "Edit selection"), ("fill", "Selectors (one per line)", "lookup_*\nsearch_*"),
                  ("fill", "Reason and what consumers should do (required: this hides tools)",
                   "Ticket writes move to the care-ops ticketing MCP; call create_ticket there."),
                  ("click", "Preview impact"), ("wait", "Impact preview")]

SHOTS = [
    # (file, base, path, theme, wait_for_text)
    ("01-how-it-works", "demo", "/how-it-works", "dark", "How It Works"),
    ("02-home", "demo", "/home", "dark", "Top actions"),
    ("03-catalog", "demo", "/catalog", "dark", "Catalog"),
    ("04-agent-overview", "demo", f"/assets/{SUP}/overview", "dark", "Care Ops Supervisor"),
    ("05-agent-access", "demo", f"/assets/{SUP}/access", "dark", "Care Ops Supervisor"),
    ("06-agent-usage-cost", "demo", f"/assets/{SUP}/usage", "dark", "Care Ops Supervisor"),
    ("07-agent-lineage", "demo", f"/assets/{SUP}/lineage", "dark", "Care Ops Supervisor"),
    ("08-agent-subscribers", "demo", f"/assets/{SUP}/subscribers", "dark", "Care Ops Supervisor"),
    ("09-subscribe-dialog", "demo", f"/assets/{SUP}/overview?subscribe=1", "dark", "Subscribe"),
    ("10-request-access-dialog", "demo", f"/assets/{SUP}/overview?request=1", "dark", "Request access"),
    ("11-impact-report", "demo", "/changes/1", "dark", "Impact"),
    ("12-lineage-explorer", "demo", f"/lineage?focus={SUP}&depth=2&dir=both", "dark", "Lineage"),
    ("13-requests-queue", "demo", "/requests?scope=all", "light", "Requests"),
    ("14-usage-cost", "demo", "/usage-cost", "light", "Usage"),
    ("15-policies", "demo", "/policies", "dark", "Policies"),
    ("16-governance", "demo", "/governance", "dark", "Governance"),
    ("17-audit", "demo", "/audit", "dark", "Audit"),
    ("18-real-mcp-catalog", "real", "/catalog?type=mcp_server&platform=databricks_system_mcp", "dark", "Catalog"),
    ("19-real-m365-overview", "real", f"/assets/{M365}/overview", "dark", "Microsoft 365"),
    ("20-real-platform-updates", "real", "/platform-updates", "dark", "Platform updates"),
    ("21-real-release-feed", "real", "/platform-updates?tab=feed", "dark", "Platform updates"),
    ("22-real-capabilities", "real", "/platform-updates?tab=capabilities", "dark", "Platform updates"),
    ("23-platform-updates-light", "demo", "/platform-updates", "light", "Platform updates"),
    ("24-lineage-publish-uc", "demo", "/governance#uc-lineage", "dark", "External metadata objects", [("click", "Request")]),
    ("25-agent365-also-registered", "demo", f"/assets/{GENIE}/overview", "dark", "Claims Analytics", [("scroll", "Also registered in")]),
    ("26-mcp-tool-selection-editor", "demo", f"/assets/{CARE_MCP}/tools", "dark", "Tool selection", EDIT_SELECTION),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", default="http://localhost:8765")
    ap.add_argument("--real", default="http://localhost:8766")
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    OUT.mkdir(parents=True, exist_ok=True)
    bases = {"demo": args.demo.rstrip("/"), "real": args.real.rstrip("/")}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome")
        for name, base, path, theme, text, *steps in SHOTS:
            if args.only and args.only not in name:
                continue
            ctx = browser.new_context(viewport={"width": 1600, "height": 1000}, device_scale_factor=1.5)
            ctx.add_init_script(f"localStorage.setItem('arh.theme', '{theme}'); sessionStorage.clear();")
            page = ctx.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(bases[base] + path, wait_until="domcontentloaded")
            try:
                page.get_by_text(text, exact=False).first.wait_for(timeout=15000)
            except Exception:  # noqa: BLE001 - capture anyway; the error list says why
                errors.append(f"text {text!r} not found")
            for step in (steps[0] if steps else []):
                try:
                    kind, target, *value = step
                    if kind == "click":
                        page.get_by_role("button", name=target).first.click()
                    elif kind == "fill":
                        page.get_by_label(target).fill(value[0])
                    elif kind == "wait":
                        page.get_by_text(target, exact=False).first.wait_for(timeout=15000)
                    elif kind == "scroll":
                        page.get_by_text(target, exact=False).first.evaluate("el => el.scrollIntoView({block: 'center'})")
                    page.wait_for_timeout(400)
                except Exception as e:  # noqa: BLE001 - capture anyway; the error list says why
                    errors.append(f"step {step[:2]}: {type(e).__name__}")
            page.wait_for_timeout(1800)  # let charts / graph layout settle
            page.screenshot(path=str(OUT / f"{name}.png"))
            print(f"{name}.png  {'OK' if not errors else 'ERR ' + '; '.join(errors)[:200]}")
            ctx.close()
        browser.close()


if __name__ == "__main__":
    main()
