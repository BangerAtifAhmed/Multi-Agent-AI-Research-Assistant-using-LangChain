"""Memory-bounded ingestion tests.

    python tests/test_large_document.py

Builds a PDF large enough to need ~1100 chunks -- the size that was restarting
the 512 MB production container -- and proves the streaming path is *bounded*:
doubling the document must not double the memory it takes to ingest.

Each measurement runs in its own subprocess, and `tracemalloc` starts only after
a warm-up extraction, so one-time imports are not charged to whichever path runs
first.
"""

from __future__ import annotations

import gc
import hashlib
import json
import os
import subprocess
import sys
import time
import tracemalloc
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

FIXTURES = Path(__file__).resolve().parent / "fixtures"
WARMUP_PDF = FIXTURES / "text.pdf"

# The large fixture is the one that matters; the half-size one exists only to
# show how peak memory responds to document length.
PAGES = 560
HALF_PAGES = 280
TARGET_CHUNKS = 1000
BATCH_SIZE = 64

PARAGRAPH = (
    "Retrieval augmented generation grounds a language model in retrieved "
    "context so that answers can cite real sources rather than relying only "
    "on parametric memory. Chunking, embedding and vector search each shape "
    "the quality of the retrieved context in different ways. "
)


def mb(value: float) -> str:
    return f"{value / 1024 / 1024:.1f} MB"


def current_rss() -> int:
    try:
        import psutil

        return int(psutil.Process().memory_info().rss)
    except Exception:  # noqa: BLE001
        return 0


def peak_rss() -> int:
    """Peak resident set size of this process, or the current RSS if unknown."""
    try:
        import psutil

        info = psutil.Process().memory_info()
        return int(getattr(info, "peak_wset", info.rss))
    except Exception:  # noqa: BLE001
        return 0


def build_pdf(pages: int, filename: str) -> Path:
    """A text PDF of `pages` pages, about two chunks per page."""
    import pymupdf

    path = FIXTURES / filename
    if path.exists():
        document = pymupdf.open(str(path))
        existing = document.page_count
        document.close()
        if existing == pages:
            return path

    FIXTURES.mkdir(parents=True, exist_ok=True)
    document = pymupdf.open()
    for page_number in range(pages):
        page = document.new_page()
        page.insert_textbox(
            pymupdf.Rect(40, 40, 560, 780),
            f"Page {page_number + 1}\n" + PARAGRAPH * 6,
            fontsize=9,
        )
    document.save(str(path))
    document.close()
    return path


# --------------------------------------------------------------------------- #
# Child process: measure one strategy against one fixture, report JSON.
# --------------------------------------------------------------------------- #

def measure(mode: str, batch_size: int, fixture: Path) -> dict:
    import extraction

    # Pay the import cost before measuring, so the peak reflects the document
    # rather than first-call overhead.
    extraction.extract_chunks(str(WARMUP_PDF), WARMUP_PDF.name)
    gc.collect()

    # Opening a PDF costs whatever pypdf needs to index the file. That floor is
    # inherent -- no batching strategy avoids it -- so it is measured separately
    # and subtracted, leaving the cost of ingestion itself.
    tracemalloc.start()
    reader = extraction._open_pdf(fixture)
    pages = len(reader.pages)
    _, open_peak = tracemalloc.get_traced_memory()
    extraction._close_pdf(reader)
    tracemalloc.stop()
    del reader
    gc.collect()

    digest = hashlib.sha256()
    rss_before = current_rss()
    batches: list[int] = []
    count = 0
    info: dict = {}
    first_result_at = None

    def absorb(chunk: dict) -> None:
        digest.update(chunk["content"].encode("utf-8"))
        digest.update(json.dumps(chunk["metadata"], sort_keys=True).encode("utf-8"))

    tracemalloc.start()
    started = time.time()

    if mode == "streaming":
        for batch in extraction.iter_chunk_batches(
            str(fixture), fixture.name, batch_size, None, info
        ):
            if first_result_at is None:
                first_result_at = time.time() - started
            batches.append(len(batch))
            count += len(batch)
            for chunk in batch:
                absorb(chunk)
            # What Express does: embed it, insert it, then let it go.
            del batch
    else:
        result = extraction.extract_chunks(str(fixture), fixture.name)
        first_result_at = time.time() - started
        count = len(result["chunks"])
        info = result.get("info", {})
        for chunk in result["chunks"]:
            absorb(chunk)

    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    return {
        "mode": mode,
        "fixture": fixture.name,
        "pages": pages,
        "batchSize": batch_size,
        "pageWindow": extraction.PDF_PAGE_WINDOW,
        "openPeak": open_peak,
        # What ingesting the document costs on top of simply opening it.
        "ingestPeak": max(0, peak - open_peak),
        "chunks": count,
        "batches": len(batches),
        "maxBatch": max(batches) if batches else count,
        "peakTraced": peak,
        "rssGrowth": max(0, peak_rss() - rss_before),
        "firstResultSeconds": round(first_result_at or 0, 2),
        "seconds": round(time.time() - started, 1),
        "digest": digest.hexdigest(),
        "info": info,
    }


if len(sys.argv) > 1 and sys.argv[1] == "--child":
    print("RESULT " + json.dumps(measure(sys.argv[2], int(sys.argv[3]), Path(sys.argv[4]))))
    raise SystemExit(0)


# --------------------------------------------------------------------------- #
# Parent process
# --------------------------------------------------------------------------- #

passed = failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {name}" + (f" -- {detail}" if detail else ""))
    else:
        failed += 1
        print(f"FAIL  {name}" + (f" -- {detail}" if detail else ""))


def run_child(mode: str, batch_size: int, fixture: Path, window: int | None = None) -> dict:
    environment = dict(os.environ)
    if window is not None:
        environment["PDF_PAGE_WINDOW"] = str(window)

    process = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--child", mode,
         str(batch_size), str(fixture)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=environment,
    )
    for line in process.stdout.splitlines():
        if line.startswith("RESULT "):
            return json.loads(line[len("RESULT "):])
    raise SystemExit(
        f"child ({mode}, batch {batch_size}, {fixture.name}) produced no result\n"
        f"{process.stdout[-2000:]}\n{process.stderr[-2000:]}"
    )


print("=== fixtures ===")
large = build_pdf(PAGES, "large.pdf")
half = build_pdf(HALF_PAGES, "large_half.pdf")
print(f"  {large.name}: {mb(large.stat().st_size)}, {PAGES} pages")
print(f"  {half.name}: {mb(half.stat().st_size)}, {HALF_PAGES} pages")

print("\n=== streaming extraction (bounded batches) ===")
streaming = run_child("streaming", BATCH_SIZE, large)
print(f"  {streaming['chunks']} chunks in {streaming['batches']} batches"
      f" of at most {streaming['maxBatch']}")
print(f"  peak python heap: {mb(streaming['peakTraced'])}"
      f"   peak RSS growth: {mb(streaming['rssGrowth'])}")
print(f"  first batch after {streaming['firstResultSeconds']}s"
      f"   total {streaming['seconds']}s")

check("large document produces the expected chunk volume",
      streaming["chunks"] >= TARGET_CHUNKS, f"{streaming['chunks']} chunks")
check("no batch exceeds the configured size",
      streaming["maxBatch"] <= BATCH_SIZE, f"max batch {streaming['maxBatch']}")
check("work is split across many batches",
      streaming["batches"] >= streaming["chunks"] / BATCH_SIZE,
      f"{streaming['batches']} batches")
check("the first batch is delivered long before extraction ends",
      streaming["firstResultSeconds"] < streaming["seconds"] / 2,
      f"{streaming['firstResultSeconds']}s of {streaming['seconds']}s")
check("page metadata is preserved",
      streaming["info"].get("pageCount") == PAGES, str(streaming["info"].get("pageCount")))
check("a text PDF still does not trigger OCR",
      streaming["info"].get("usedOcr") is False, str(streaming["info"].get("usedOcr")))

# ---- the property that actually matters: peak must not track document size ---
print("\n=== does peak memory grow with the document? ===")
streaming_half = run_child("streaming", BATCH_SIZE, half)
eager = run_child("eager", BATCH_SIZE, large)
eager_half = run_child("eager", BATCH_SIZE, half)

streaming_growth = streaming["ingestPeak"] / max(streaming_half["ingestPeak"], 1)
eager_growth = eager["ingestPeak"] / max(eager_half["ingestPeak"], 1)
open_growth = streaming["openPeak"] / max(streaming_half["openPeak"], 1)

print(f"  opening the file  {HALF_PAGES}p {mb(streaming_half['openPeak'])}"
      f" -> {PAGES}p {mb(streaming['openPeak'])}   ({open_growth:.2f}x, inherent to pypdf)")
print(f"  ingest streaming  {HALF_PAGES}p {mb(streaming_half['ingestPeak'])}"
      f" -> {PAGES}p {mb(streaming['ingestPeak'])}   ({streaming_growth:.2f}x)")
print(f"  ingest eager      {HALF_PAGES}p {mb(eager_half['ingestPeak'])}"
      f" -> {PAGES}p {mb(eager['ingestPeak'])}   ({eager_growth:.2f}x)")

check("doubling the document does not raise the streaming ingestion cost",
      streaming_growth < 1.25, f"{streaming_growth:.2f}x for 2x the chunks")
check("the eager ingestion cost does grow with the document",
      eager_growth > 1.3, f"{eager_growth:.2f}x")
check("streaming stays flatter than eager as documents grow",
      streaming_growth < eager_growth,
      f"{streaming_growth:.2f}x vs {eager_growth:.2f}x")
check("streaming peaks lower than eager on the large document",
      streaming["peakTraced"] < eager["peakTraced"],
      f"{mb(streaming['peakTraced'])} < {mb(eager['peakTraced'])}")

print("\n=== output is unchanged by streaming ===")
check("both paths produce the same number of chunks",
      streaming["chunks"] == eager["chunks"], f"{streaming['chunks']} vs {eager['chunks']}")
check("chunk text and metadata are byte-identical between the two paths",
      streaming["digest"] == eager["digest"], streaming["digest"][:16])

print("\n=== the tuning knobs bound the peak ===")
small_batch = run_child("streaming", 8, large)
small_window = run_child("streaming", BATCH_SIZE, large, window=10)
print(f"  batch 8:        peak {mb(small_batch['peakTraced'])}"
      f" in {small_batch['batches']} batches")
print(f"  page window 10: peak {mb(small_window['peakTraced'])}"
      f" (default {streaming['pageWindow']})")

check("batch_size=8 is respected", small_batch["maxBatch"] <= 8, f"max {small_batch['maxBatch']}")
check("a smaller page window lowers the peak further",
      small_window["peakTraced"] < streaming["peakTraced"],
      f"{mb(small_window['peakTraced'])} < {mb(streaming['peakTraced'])}")
check("neither knob changes the output",
      small_batch["digest"] == streaming["digest"]
      and small_window["digest"] == streaming["digest"])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
