"""Does ingestion memory grow with page count?

    python tests/test_scalability.py

Extraction is measured at 280, 560 and 1000 pages. Each size runs in its own
subprocess, and `tracemalloc` starts only after a warm-up, so one-time imports
are not charged to whichever size happens to run first.

Two costs are separated, because only one of them is under our control:

  * opening the file  - pypdf indexes the whole document up front. This is
                        inherent and grows with page count.
  * ingestion         - everything after that: reading pages, splitting,
                        batching. This is what must stay flat.
"""

from __future__ import annotations

import gc
import hashlib
import json
import subprocess
import sys
import time
import tracemalloc
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests.make_fixtures import make_paged_pdf  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
WARMUP_PDF = FIXTURES / "text.pdf"

SIZES = [(280, "large_half.pdf"), (560, "large.pdf"), (1000, "large_1000.pdf")]
BATCH_SIZE = 64


def mb(value: float) -> str:
    return f"{value / 1024 / 1024:.1f} MB"


def rss() -> int:
    try:
        import psutil

        return int(psutil.Process().memory_info().rss)
    except Exception:  # noqa: BLE001
        return 0


def peak_rss() -> int:
    try:
        import psutil

        info = psutil.Process().memory_info()
        return int(getattr(info, "peak_wset", info.rss))
    except Exception:  # noqa: BLE001
        return 0


# --------------------------------------------------------------------------- #
# Child: measure one document, report JSON.
# --------------------------------------------------------------------------- #

def measure(fixture: Path) -> dict:
    import extraction

    extraction.extract_chunks(str(WARMUP_PDF), WARMUP_PDF.name)
    gc.collect()

    tracemalloc.start()
    reader = extraction._open_pdf(fixture)
    pages = len(reader.pages)
    _, open_peak = tracemalloc.get_traced_memory()
    extraction._close_pdf(reader)
    tracemalloc.stop()
    del reader
    gc.collect()

    digest = hashlib.sha256()
    rss_before = rss()
    batches: list[int] = []
    count = 0
    info: dict = {}
    first_batch_at = None

    tracemalloc.start()
    started = time.time()
    for batch in extraction.iter_chunk_batches(str(fixture), fixture.name, BATCH_SIZE, None, info):
        if first_batch_at is None:
            first_batch_at = time.time() - started
        batches.append(len(batch))
        count += len(batch)
        for chunk in batch:
            digest.update(chunk["content"].encode("utf-8"))
            digest.update(json.dumps(chunk["metadata"], sort_keys=True).encode("utf-8"))
        del batch
    seconds = time.time() - started
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    return {
        "pages": pages,
        "chunks": count,
        "batches": len(batches),
        "maxBatch": max(batches) if batches else 0,
        "openPeak": open_peak,
        "ingestPeak": max(0, peak - open_peak),
        "totalPeak": peak,
        "rssGrowth": max(0, peak_rss() - rss_before),
        "firstBatchSeconds": round(first_batch_at or 0, 2),
        "seconds": round(seconds, 1),
        "digest": digest.hexdigest()[:16],
        "usedOcr": info.get("usedOcr"),
        "pageCount": info.get("pageCount"),
    }


if len(sys.argv) > 1 and sys.argv[1] == "--child":
    print("RESULT " + json.dumps(measure(Path(sys.argv[2]))))
    raise SystemExit(0)


# --------------------------------------------------------------------------- #
# Parent
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


def run_child(fixture: Path) -> dict:
    process = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--child", str(fixture)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    for line in process.stdout.splitlines():
        if line.startswith("RESULT "):
            return json.loads(line[len("RESULT "):])
    raise SystemExit(f"child failed for {fixture.name}\n{process.stdout[-1500:]}\n"
                     f"{process.stderr[-1500:]}")


print("=== fixtures ===")
results = []
for pages, filename in SIZES:
    path = make_paged_pdf(pages, filename)
    print(f"  {filename}: {pages} pages, {mb(path.stat().st_size)}")

print("\n=== measuring ===")
for pages, filename in SIZES:
    result = run_child(FIXTURES / filename)
    result["label"] = f"{pages}p"
    results.append(result)
    print(f"  {pages:>4} pages: {result['chunks']:>4} chunks in {result['batches']:>2} batches"
          f" | open {mb(result['openPeak']):>8} | ingest {mb(result['ingestPeak']):>8}"
          f" | {result['seconds']:>5}s")

smallest, largest = results[0], results[-1]
page_ratio = largest["pages"] / smallest["pages"]
chunk_ratio = largest["chunks"] / smallest["chunks"]
ingest_ratio = largest["ingestPeak"] / max(smallest["ingestPeak"], 1)
open_ratio = largest["openPeak"] / max(smallest["openPeak"], 1)
time_ratio = largest["seconds"] / max(smallest["seconds"], 0.01)

print(f"\n=== {smallest['label']} -> {largest['label']}"
      f" ({page_ratio:.1f}x the pages, {chunk_ratio:.1f}x the chunks) ===")
print(f"  ingestion memory: {mb(smallest['ingestPeak'])} -> {mb(largest['ingestPeak'])}"
      f"   ({ingest_ratio:.2f}x)")
print(f"  file index (pypdf, inherent): {mb(smallest['openPeak'])} -> {mb(largest['openPeak'])}"
      f"   ({open_ratio:.2f}x)")
print(f"  time: {smallest['seconds']}s -> {largest['seconds']}s   ({time_ratio:.2f}x)")

check("ingestion memory does not grow with page count",
      ingest_ratio < 1.25, f"{ingest_ratio:.2f}x for {page_ratio:.1f}x the pages")
check("ingestion memory grows far slower than the document",
      ingest_ratio < chunk_ratio / 2, f"{ingest_ratio:.2f}x vs {chunk_ratio:.1f}x the chunks")
check("time grows roughly with the work, as expected",
      time_ratio > 1.5, f"{time_ratio:.2f}x")

for result in results:
    check(f"{result['label']}: batches stay within the configured size",
          result["maxBatch"] <= BATCH_SIZE, f"max {result['maxBatch']}")
    check(f"{result['label']}: streaming starts before extraction finishes",
          result["firstBatchSeconds"] < result["seconds"] / 2,
          f"first batch at {result['firstBatchSeconds']}s of {result['seconds']}s")
    check(f"{result['label']}: all pages were read",
          result["pageCount"] == result["pages"], str(result["pageCount"]))
    check(f"{result['label']}: no OCR on a text PDF", result["usedOcr"] is False)

# Per-chunk cost must fall as documents grow; a proportional design keeps it flat.
print("\n=== cost per chunk ===")
for result in results:
    per_chunk = result["ingestPeak"] / max(result["chunks"], 1)
    print(f"  {result['label']:>6}: {per_chunk:,.0f} B/chunk")
check("per-chunk memory cost falls as the document grows",
      largest["ingestPeak"] / largest["chunks"] < smallest["ingestPeak"] / smallest["chunks"],
      "bounded working set spread over more chunks")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
