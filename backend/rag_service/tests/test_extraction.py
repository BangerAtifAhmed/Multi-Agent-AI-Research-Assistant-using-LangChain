"""Extraction tests covering every supported format and the failure modes.

Run from backend/rag_service:

    python tests/test_extraction.py

Cases that need an absent system dependency (OCR, LibreOffice) are reported as
SKIP with the reason, never as a false pass.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import capabilities  # noqa: E402
import extraction  # noqa: E402
from tests import make_fixtures  # noqa: E402

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


def expect_error(name: str, path: Path, expected_code: str | None = None) -> None:
    try:
        extraction.extract_chunks(str(path))
        check(name, False, "expected an ExtractionError but extraction succeeded")
    except extraction.ExtractionError as exc:
        ok = expected_code is None or exc.code == expected_code
        check(name, ok, f"{exc.code}: {str(exc)[:70]}")
    except Exception as exc:  # noqa: BLE001
        check(name, False, f"raised {type(exc).__name__} instead of ExtractionError: {exc}")


print("=== building fixtures ===")
make_fixtures.build_all()
print()

print("=== capabilities ===")
caps = capabilities.capabilities()
for key, value in caps.items():
    state = "available" if value["available"] else f"UNAVAILABLE ({value.get('reason', '')})"
    print(f"  {key:<12} {state}")
print()

# ---------------------------------------------------------------- TXT ------
print("=== TXT ===")
result = extraction.extract_chunks(str(FIXTURES / "sample.txt"))
chunks = result["chunks"]
check("txt produces chunks", len(chunks) > 0, f"{len(chunks)} chunks")
check("txt keeps content", any("Revenue grew" in c["content"] for c in chunks))
check("txt records line metadata", all("line" in c["metadata"] for c in chunks))
check("txt records filename", all(c["metadata"]["document_name"] == "sample.txt" for c in chunks))
check(
    "txt preserves paragraph separation",
    any("dividend" in c["content"] for c in chunks),
)

# ----------------------------------------------------------------- MD ------
print("\n=== Markdown ===")
result = extraction.extract_chunks(str(FIXTURES / "sample.md"))
chunks = result["chunks"]
sections = {c["metadata"].get("section") for c in chunks}
check("md produces chunks", len(chunks) > 0, f"{len(chunks)} chunks")
check("md tracks heading sections", "Indexing strategies" in sections, str(sections))
check("md keeps heading markers", any(c["content"].startswith("#") for c in chunks))
check("md keeps code fences intact", any("```sql" in c["content"] for c in chunks))
check("md records line numbers", all("line" in c["metadata"] for c in chunks))

# ---------------------------------------------------------------- PDF ------
print("\n=== PDF (selectable text) ===")
result = extraction.extract_chunks(str(FIXTURES / "text.pdf"))
chunks = result["chunks"]
pages = sorted({c["metadata"]["page"] for c in chunks})
check("pdf produces chunks", len(chunks) > 0, f"{len(chunks)} chunks")
check("pdf records page numbers", pages == [1, 2], str(pages))
check("pdf pages are 1-based", min(pages) == 1)
check("pdf extracted real text", any("update gate" in c["content"] for c in chunks))
check("no OCR used on a text PDF", result["info"]["usedOcr"] is False, str(result["info"]))

# ------------------------------------------------------- PDF (scanned) -----
print("\n=== PDF (scanned, needs OCR) ===")
if capabilities.ocr_available():
    result = extraction.extract_chunks(str(FIXTURES / "scanned.pdf"))
    text = " ".join(c["content"] for c in result["chunks"]).upper()
    check("scanned pdf produced text", len(result["chunks"]) > 0)
    check("OCR was used", result["info"]["usedOcr"] is True, str(result["info"]))
    check("OCR read the content", "SCANNED" in text or "INVOICE" in text, text[:80])
else:
    # Must fail loudly with an actionable message, never silently return nothing.
    expect_error("scanned pdf reports missing OCR clearly", FIXTURES / "scanned.pdf", "OCR_UNAVAILABLE")
    skip("OCR content check", caps["ocr"].get("reason", "OCR unavailable"))

# --------------------------------------------------------- PDF (mixed) -----
print("\n=== PDF (mixed text + scanned page) ===")
if capabilities.ocr_available():
    result = extraction.extract_chunks(str(FIXTURES / "mixed.pdf"))
    pages = sorted({c["metadata"]["page"] for c in result["chunks"]})
    text = " ".join(c["content"] for c in result["chunks"])
    check("mixed pdf read both pages", pages == [1, 2], str(pages))
    check("text page read without OCR", "selectable text" in text)
    check("image page read via OCR", "APPENDIX" in text.upper(), text[-90:])
    check("OCR limited to the scanned page", result["info"]["ocrPages"] == 1, str(result["info"]))
else:
    expect_error("mixed pdf reports missing OCR clearly", FIXTURES / "mixed.pdf", "OCR_UNAVAILABLE")
    skip("mixed pdf OCR check", caps["ocr"].get("reason", "OCR unavailable"))

# --------------------------------------------------------------- DOCX ------
print("\n=== DOCX ===")
if caps[".docx"]["available"]:
    result = extraction.extract_chunks(str(FIXTURES / "sample.docx"))
    chunks = result["chunks"]
    sections = {c["metadata"].get("section") for c in chunks}
    text = " ".join(c["content"] for c in chunks)
    check("docx produces chunks", len(chunks) > 0, f"{len(chunks)} chunks")
    check("docx records paragraph numbers", any("paragraph" in c["metadata"] for c in chunks))
    check("docx tracks heading sections", "Common algorithms" in sections, str(sections))
    check("docx preserves list items", "- Gradient boosted trees" in text)
    check("docx extracts table content", "Random forest | 0.91" in text, text[-80:])
    check("docx is not treated as an image", "Supervised learning" in text)
else:
    skip("DOCX", caps[".docx"].get("reason", "unavailable"))

# --------------------------------------------------------------- PPTX ------
print("\n=== PPTX ===")
if caps[".pptx"]["available"]:
    result = extraction.extract_chunks(str(FIXTURES / "sample.pptx"))
    chunks = result["chunks"]
    slides = sorted({c["metadata"]["slide"] for c in chunks})
    text = " ".join(c["content"] for c in chunks)
    check("pptx produces chunks", len(chunks) > 0, f"{len(chunks)} chunks")
    check("pptx records slide numbers", slides == [1, 2, 3], str(slides))
    check("pptx extracts slide titles", "# Retrieval Augmented Generation" in text)
    check("pptx extracts bullet points", "- Ground the model in real sources" in text)
    check("pptx extracts speaker notes", "citation accuracy" in text)
    check("pptx extracts free text boxes", "pgvector" in text)
    check("pptx slide metadata usable for citations", result["info"]["slideCount"] == 3)
else:
    skip("PPTX", caps[".pptx"].get("reason", "unavailable"))

# ------------------------------------------------------- legacy formats ----
print("\n=== Legacy .doc / .ppt (LibreOffice) ===")
print(f"  LIBREOFFICE_PATH env : {os.getenv('LIBREOFFICE_PATH') or '(not set)'}")
print(f"  resolved soffice     : {capabilities.libreoffice_path() or '(not found)'}")

if caps[".doc"]["available"]:
    check("LibreOffice detected", capabilities.libreoffice_path() is not None)

    result = extraction.extract_chunks(str(FIXTURES / "sample.doc"))
    chunks = result["chunks"]
    text = " ".join(c["content"] for c in chunks)
    check("doc produces chunks", len(chunks) > 0, f"{len(chunks)} chunks")
    check("doc converted via LibreOffice", result["info"].get("convertedFrom") == ".doc",
          str(result["info"]))
    check("doc content extracted", "Supervised learning" in text, text[:70])
    check("doc keeps heading sections",
          any(c["metadata"].get("section") for c in chunks),
          str({c["metadata"].get("section") for c in chunks}))

    result = extraction.extract_chunks(str(FIXTURES / "sample.ppt"))
    chunks = result["chunks"]
    slides = sorted({c["metadata"]["slide"] for c in chunks})
    text = " ".join(c["content"] for c in chunks)
    check("ppt produces chunks", len(chunks) > 0, f"{len(chunks)} chunks")
    check("ppt converted via LibreOffice", result["info"].get("convertedFrom") == ".ppt",
          str(result["info"]))
    check("ppt records slide numbers", len(slides) >= 3, str(slides))
    check("ppt content extracted", "Retrieval Augmented Generation" in text, text[:70])
else:
    skip(".doc / .ppt", caps[".doc"].get("reason", "unavailable"))

    # Without LibreOffice the failure must name the dependency, not be obscure.
    legacy = FIXTURES / "legacy.doc"
    legacy.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 128)
    try:
        extraction.extract_chunks(str(legacy))
        check("legacy .doc without LibreOffice", False, "unexpectedly succeeded")
    except extraction.ExtractionError as exc:
        check(
            "legacy .doc without LibreOffice names LIBREOFFICE_PATH",
            "LIBREOFFICE_PATH" in str(exc),
            str(exc)[:80],
        )

# PDF / TXT / MD must not depend on LibreOffice at all.
check(
    "PDF does not require LibreOffice",
    caps[".pdf"]["available"] and "LibreOffice" not in caps[".pdf"]["requires"],
    caps[".pdf"]["requires"],
)
check(
    "TXT/MD do not require LibreOffice",
    caps[".txt"]["requires"] == "none" and caps[".md"]["requires"] == "none",
)
check(
    "DOCX/PPTX read natively, not via LibreOffice",
    "LibreOffice" not in caps[".docx"]["requires"] and "LibreOffice" not in caps[".pptx"]["requires"],
    f'docx: {caps[".docx"]["requires"]}, pptx: {caps[".pptx"]["requires"]}',
)

# ------------------------------------------------------------- failures ----
print("\n=== Failure modes ===")
expect_error("unsupported extension rejected", FIXTURES / "script.sh", "UNSUPPORTED_FILE_TYPE")
expect_error("empty file rejected", FIXTURES / "empty.txt", "EMPTY_DOCUMENT")
expect_error("whitespace-only file rejected", FIXTURES / "whitespace.txt", "NO_TEXT_EXTRACTED")
expect_error("corrupted pdf rejected", FIXTURES / "corrupted.pdf")
expect_error("corrupted docx reports a parser failure", FIXTURES / "corrupted.docx", "PARSE_FAILED")
expect_error("missing file rejected", FIXTURES / "does-not-exist.pdf", "FILE_MISSING")

# The corrupted DOCX must NOT be reported as "no readable text": the real
# problem is that the parser could not open it at all.
try:
    extraction.extract_chunks(str(FIXTURES / "corrupted.docx"))
    check("corrupted docx message accuracy", False, "unexpectedly succeeded")
except extraction.ExtractionError as exc:
    check(
        "corrupted docx does not claim 'no readable text'",
        exc.code == "PARSE_FAILED" and "corrupted" in str(exc).lower(),
        str(exc)[:80],
    )

print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
sys.exit(1 if failed else 0)
