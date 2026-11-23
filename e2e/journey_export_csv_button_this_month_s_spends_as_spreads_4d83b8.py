"""Browser journey: Export CSV downloads this month's spends, online and offline.

Serves the repository on loopback, adds '120 chai' and '45.50 auto' with the
quick-entry box, reads the This month card, then on the Backup tab taps
Export CSV once online and once in airplane mode. Both downloads must be
named rupee-ledger-YYYY-MM.csv for this month, hold one row per spend, and
their Amount column must sum to the This month card. The page makes no
request to any other origin.

Run: python3 e2e/journey_export_csv_button_this_month_s_spends_as_spreads_4d83b8.py
Needs the Python `playwright` package and its Chromium build.
"""

import csv
import functools
import http.server
import io
import re
import sys
import threading
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SPENDS = ["120 chai", "45.50 auto"]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".webmanifest": "application/manifest+json",
    }

    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def rupees(text):
    """'₹165.5'-style card text as a Decimal number of rupees."""
    digits = re.sub(r"[^0-9.]", "", text)
    assert digits, f"no amount in {text!r}"
    return Decimal(digits)


def read_rows(download):
    path = download.path()
    text = Path(path).read_text(encoding="utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    assert rows[0] == ["Date", "Amount (₹)", "Category", "Note"], rows[0]
    return [row for row in rows[1:] if row]


def export_once(page, expected_name):
    button = page.get_by_role("button", name="Export CSV")
    expect(button).to_be_visible()
    with page.expect_download() as info:
        button.click()
    download = info.value
    assert download.suggested_filename == expected_name, download.suggested_filename
    expect(page.get_by_text(f"Downloaded {expected_name} with 2 spends.")).to_be_visible()
    expect(button).to_be_enabled()
    return read_rows(download)


def main():
    server = serve()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    foreign = []
    errors = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            context = browser.new_context(
                viewport={"width": 390, "height": 844},
                accept_downloads=True,
                service_workers="block",
            )
            page = context.new_page()
            page.on("request", lambda r: foreign.append(r.url) if not r.url.startswith((base, "blob:", "data:")) else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

            page.goto(base + "/index.html#/today")
            entry = page.get_by_label("Add a spend")
            expect(entry).to_be_visible()
            for count, spend in enumerate(SPENDS, start=1):
                entry.fill(spend)
                entry.press("Enter")
                expect(page.get_by_text("1 spend" if count == 1 else f"{count} spends", exact=True)).to_be_visible()
                # The row is listed at once; wait for the store to confirm it.
                expect(page.locator("[data-entry-status]")).to_have_text(re.compile(r"^Added .*" + spend.split()[1]))
            month_card = page.locator("[data-month-total]")
            expect(month_card).to_have_text(re.compile(r"^₹165\.50?$"))
            card_total = rupees(month_card.inner_text())

            page.get_by_role("navigation", name="Primary").get_by_role("link", name="Backup", exact=True).click()
            expect(page.get_by_role("heading", name="This month’s spends")).to_be_visible()

            now = datetime.now()
            expected_name = f"rupee-ledger-{now.year:04d}-{now.month:02d}.csv"
            month_prefix = f"{now.year:04d}-{now.month:02d}-"

            downloads = []
            downloads.append(export_once(page, expected_name))

            context.set_offline(True)
            downloads.append(export_once(page, expected_name))

            for rows in downloads:
                assert len(rows) == 2, rows
                assert sorted(row[3] for row in rows) == ["auto", "chai"], rows
                assert all(row[0].startswith(month_prefix) for row in rows), rows
                total = sum(Decimal(row[1]) for row in rows)
                assert total == card_total == Decimal("165.50"), (total, card_total)

            assert not foreign, f"requests left the phone: {foreign}"
            assert not errors, f"console errors: {errors}"
            browser.close()
    finally:
        server.shutdown()
    print(f"PASS: two downloads named {expected_name}, each summing to ₹{card_total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
