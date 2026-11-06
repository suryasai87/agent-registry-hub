"""Render the whitepaper (whitepaper.html → PDF) with the installed Chrome.

    uv run --with playwright --index-url https://pypi.org/simple/ \
        python docs/whitepaper/build.py [--prepared-for "Prepared for …"] [--out file.pdf] [--png]

``--prepared-for`` adds an addressee line to the cover (keep customer-addressed editions out of the repo).
``--png`` also writes one PNG per page next to the PDF for visual QA.
"""
from __future__ import annotations

import argparse
import html
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARKER = "<!--PREPARED_FOR-->"


def main() -> None:
    from playwright.sync_api import sync_playwright

    ap = argparse.ArgumentParser()
    ap.add_argument("--prepared-for", default="")
    ap.add_argument("--out", default=str(HERE / "build" / "agent-registry-hub-whitepaper.pdf"))
    ap.add_argument("--png", action="store_true")
    args = ap.parse_args()

    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    source = (HERE / "whitepaper.html").read_text()
    if args.prepared_for:
        source = source.replace(MARKER, f'<div class="prepared">{html.escape(args.prepared_for)}</div>')
    page_file = HERE / ".render.html"  # next to whitepaper.html so img/ paths resolve
    page_file.write_text(source)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome")
            page = browser.new_page(viewport={"width": 816, "height": 1056}, device_scale_factor=2)
            page.goto(page_file.as_uri(), wait_until="networkidle")
            page.evaluate("document.fonts.ready")
            page.pdf(path=str(out), format="Letter", print_background=True, prefer_css_page_size=True,
                     margin={"top": "0", "right": "0", "bottom": "0", "left": "0"})
            if args.png:
                for i, section in enumerate(page.query_selector_all("section.page"), start=1):
                    section.screenshot(path=str(out.with_name(f"{out.stem}-p{i:02d}.png")))
            browser.close()
    finally:
        page_file.unlink(missing_ok=True)
    print(out)


if __name__ == "__main__":
    main()
