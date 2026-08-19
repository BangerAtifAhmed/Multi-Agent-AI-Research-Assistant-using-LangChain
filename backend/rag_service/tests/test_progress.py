"""Progress reporting from the extractor.

    python tests/test_progress.py

The UI promises never to invent a number, which only holds if the extractor
reports real counts. This checks what is actually emitted for each format: the
page total before any page is read, a tick as pages go by, one event per OCRed
page, and block counts for the formats that have no pages.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import capabilities  # noqa: E402
import extraction  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"

passed = failed = skipped = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {name}" + (f" -- {detail}" if detail else ""))
    else:
        failed += 1
        print(f"FAIL  {name}" + (f" -- {detail}" if detail else ""))


def skip(name: str, reason: str) -> None:
    global skipped
    skipped += 1
    print(f"SKIP  {name} -- {reason}")


def collect(fixture: str, batch_size: int = 64) -> tuple[list[dict], dict, int]:
    events: list[dict] = []
    info: dict = {}
    chunks = sum(
        len(batch)
        for batch in extraction.iter_chunk_batches(
            str(FIXTURES / fixture), fixture, batch_size, events.append, info
        )
    )
    return events, info, chunks


print("=== PDF: page progress ===")
events, info, chunks = collect("large_half.pdf")
extracting = [e for e in events if e.get("stage") == "extracting"]

check("progress events are emitted", len(events) > 0, f"{len(events)} events")
check("the page total is known before any page is read",
      extracting[0].get("page") == 0 and extracting[0].get("pages") == 280,
      str(extracting[0]))
check("every event carries a stage", all("stage" in e for e in events))
check("the page counter only moves forward",
      all(b.get("page", 0) >= a.get("page", 0) for a, b in zip(extracting, extracting[1:])))
check("the final event reports the last page",
      extracting[-1].get("page") == 280, str(extracting[-1]))
check("the total never changes mid-run",
      len({e["pages"] for e in extracting if "pages" in e}) == 1)
check("reporting is throttled, not one event per page",
      len(events) < 280 / 2, f"{len(events)} events for 280 pages")
check("but frequent enough to look live",
      len(events) >= 280 / extraction.PROGRESS_PAGE_INTERVAL,
      f"{len(events)} events")
check("the page count matches what the extractor recorded",
      info.get("pageCount") == 280, str(info.get("pageCount")))

print("\n=== scanned PDF: OCR progress ===")
if not capabilities.ocr_available():
    skip("OCR progress", "Tesseract is not installed here")
else:
    events, info, chunks = collect("scanned.pdf")
    ocr_events = [e for e in events if e.get("stage") == "ocr"]
    check("an OCR event is emitted for the scanned page",
          len(ocr_events) == 1, f"{len(ocr_events)} events")
    check("the OCR event carries page and total",
          ocr_events[0].get("page") == 1 and ocr_events[0].get("pages") == 1,
          str(ocr_events[0]))
    check("the OCR event counts pages OCRed",
          ocr_events[0].get("ocrPages") == 1, str(ocr_events[0]))
    check("OCR was actually used", info.get("usedOcr") is True)

    events, info, chunks = collect("mixed.pdf")
    ocr_events = [e for e in events if e.get("stage") == "ocr"]
    check("a mixed PDF reports OCR only for the scanned page",
          len(ocr_events) == info.get("ocrPages") == 1,
          f"{len(ocr_events)} events, {info.get('ocrPages')} pages OCRed")
    check("the mixed PDF still reports its full page count",
          all(e.get("pages") == info["pageCount"] for e in ocr_events),
          str(info.get("pageCount")))

print("\n=== formats without pages ===")
for fixture, extension in [("sample.md", ".md"), ("sample.txt", ".txt"),
                           ("sample.docx", ".docx"), ("sample.pptx", ".pptx")]:
    events, info, chunks = collect(fixture)
    with_totals = [e for e in events if "blocks" in e]
    check(f"{extension}: reports how many blocks there are",
          bool(with_totals) and with_totals[0]["blocks"] > 0,
          f"{with_totals[0]['blocks'] if with_totals else 0} blocks")
    check(f"{extension}: reports progress through those blocks",
          any("block" in e for e in events),
          f"{len([e for e in events if 'block' in e])} ticks")
    check(f"{extension}: the last tick equals the total",
          events[-1].get("block") == events[-1].get("blocks"), str(events[-1]))

print("\n=== legacy formats ===")
if not capabilities.libreoffice_path():
    skip("legacy .doc/.ppt progress", "LibreOffice is not installed here")
else:
    for fixture, extension in [("sample.doc", ".doc"), ("sample.ppt", ".ppt")]:
        events, info, chunks = collect(fixture)
        check(f"{extension}: reports block progress after conversion",
              any("block" in e for e in events) and events[-1].get("block") ==
              events[-1].get("blocks"),
              str(events[-1]))

print("\n=== progress never breaks ingestion ===")


def explode(_event):
    raise RuntimeError('progress consumer blew up')


info: dict = {}
chunks = sum(
    len(batch)
    for batch in extraction.iter_chunk_batches(
        str(FIXTURES / "sample.md"), "sample.md", 64, explode, info
    )
)
check("a failing progress callback does not fail extraction", chunks > 0, f"{chunks} chunks")

info = {}
chunks = sum(
    len(batch)
    for batch in extraction.iter_chunk_batches(
        str(FIXTURES / "text.pdf"), "text.pdf", 64, None, info
    )
)
check("no progress callback at all is fine", chunks > 0, f"{chunks} chunks")

print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
sys.exit(1 if failed else 0)
