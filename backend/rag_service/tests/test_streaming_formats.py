"""Every supported format through the batched ingestion path.

    python tests/test_streaming_formats.py

The memory work changed how chunks reach Express: they now arrive in bounded
batches instead of one list. PDF gained a windowed reader on top of that. This
checks the other six formats were carried along correctly -- same chunks, same
metadata, same batching contract -- rather than only PDF being fixed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import capabilities  # noqa: E402
import extraction  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"

# extension -> (fixture, metadata keys at least one chunk must carry)
FORMATS = {
    ".pdf": ("text.pdf", {"page"}),
    ".txt": ("sample.txt", {"line"}),
    ".md": ("sample.md", {"line", "section"}),
    ".docx": ("sample.docx", {"paragraph", "section"}),
    ".pptx": ("sample.pptx", {"slide", "title"}),
    ".doc": ("sample.doc", {"paragraph", "section"}),
    ".ppt": ("sample.ppt", {"slide", "title"}),
}

# .doc and .ppt need LibreOffice; everything else is read natively.
NEEDS_LIBREOFFICE = {".doc", ".ppt"}

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


def fingerprint(chunks: list[dict]) -> str:
    """Content plus metadata, so any drift between the two paths shows up."""
    return json.dumps(
        [[c["content"], c["metadata"]] for c in chunks], sort_keys=True, ensure_ascii=False
    )


libreoffice = capabilities.libreoffice_path()
print(f"LibreOffice: {libreoffice or 'not available'}\n")

results: dict[str, dict] = {}

for extension, (filename, expected_keys) in FORMATS.items():
    path = FIXTURES / filename
    print(f"=== {extension} ({filename}) ===")

    if extension in NEEDS_LIBREOFFICE and not libreoffice:
        skip(f"{extension} streaming", "LibreOffice is not installed here")
        print()
        continue

    # --- the streamed path, in small batches ------------------------------
    info: dict = {}
    batches = list(extraction.iter_chunk_batches(str(path), filename, 2, None, info))
    streamed = [chunk for batch in batches for chunk in batch]

    # --- the eager path, for comparison -----------------------------------
    eager = extraction.extract_chunks(str(path), filename)

    check(f"{extension}: produces chunks", len(streamed) > 0, f"{len(streamed)} chunks")
    check(f"{extension}: batches respect the requested size",
          all(len(batch) <= 2 for batch in batches),
          f"{len(batches)} batches, max {max(len(b) for b in batches)}")
    check(f"{extension}: streamed output matches the eager path exactly",
          fingerprint(streamed) == fingerprint(eager["chunks"]),
          f"{len(streamed)} vs {len(eager['chunks'])} chunks")

    # --- metadata the citations depend on ---------------------------------
    seen_keys = set()
    for chunk in streamed:
        seen_keys.update(k for k, v in chunk["metadata"].items() if v is not None)
    present = expected_keys & seen_keys
    check(f"{extension}: carries {'/'.join(sorted(expected_keys))} metadata",
          bool(present), f"found {sorted(present) or 'nothing'}")

    check(f"{extension}: every chunk names its document",
          all(c["metadata"].get("document_name") == filename for c in streamed))
    indices = [c["metadata"]["chunk_index"] for c in streamed]
    check(f"{extension}: chunk_index is contiguous across batch boundaries",
          indices == list(range(len(streamed))),
          f"0..{indices[-1] if indices else '-'}")
    check(f"{extension}: no chunk is empty",
          all(c["content"].strip() for c in streamed))

    if extension in NEEDS_LIBREOFFICE:
        check(f"{extension}: reports the LibreOffice conversion",
              info.get("convertedFrom") == extension, str(info.get("convertedFrom")))

    results[extension] = {
        "chunks": len(streamed),
        "batches": len(batches),
        "metadata": sorted(present),
        "info": {k: v for k, v in info.items() if k != "chunks"},
    }
    print(f"      {len(streamed)} chunks in {len(batches)} batches; info={results[extension]['info']}")
    print()

# --- batch size must not alter the output for any format ------------------
print("=== batch size does not change the result ===")
for extension, (filename, _) in FORMATS.items():
    if extension in NEEDS_LIBREOFFICE and not libreoffice:
        continue
    path = FIXTURES / filename
    variants = {}
    for size in (1, 3, 64):
        chunks = [c for batch in extraction.iter_chunk_batches(str(path), filename, size, None, {})
                  for c in batch]
        variants[size] = fingerprint(chunks)
    check(f"{extension}: identical output at batch sizes 1, 3 and 64",
          len(set(variants.values())) == 1)

print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
sys.exit(1 if failed else 0)
