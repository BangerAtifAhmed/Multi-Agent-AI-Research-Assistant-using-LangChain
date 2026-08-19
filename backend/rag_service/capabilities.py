"""Runtime capability detection for document ingestion.

Every optional dependency is probed once and reported honestly. The rule is:
never advertise a format the environment cannot actually process. If Tesseract
or LibreOffice is missing, the affected formats are reported as unavailable with
an actionable reason instead of silently producing an empty document.

Binary lookup order (first hit wins):
  1. an explicit environment variable  (LIBREOFFICE_PATH / TESSERACT_PATH)
  2. a legacy alias                    (SOFFICE_CMD / TESSERACT_CMD)
  3. the PATH
  4. well-known install locations for Windows, Linux and macOS

Nothing is hard-coded in the extraction logic: it only ever asks this module
for a path. The same code therefore works with a Windows install, a Linux
package, and the LibreOffice inside the Docker image.
"""

from __future__ import annotations

import functools
import os
import shutil
import sys
from pathlib import Path

# Imported for its side effect: settings loads backend/.env, so LIBREOFFICE_PATH
# and TESSERACT_PATH are populated even when this module is used on its own
# (a test, a REPL) rather than through the FastAPI app.
import settings  # noqa: F401

# Locations installers use that are not always on PATH.
TESSERACT_CANDIDATES = [
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe"),
    "/usr/bin/tesseract",
    "/usr/local/bin/tesseract",
    "/opt/homebrew/bin/tesseract",
]

SOFFICE_CANDIDATES = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\LibreOffice\program\soffice.exe"),
    # Debian/Ubuntu packages, including the Docker image.
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/usr/local/bin/soffice",
    "/opt/libreoffice/program/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
]


def _clean(value: str | None) -> str:
    """Env values may arrive quoted; Windows paths keep their backslashes.

    Only surrounding quotes and whitespace are stripped - the path itself is
    never rewritten, so `C:\\Program Files\\LibreOffice\\program\\soffice.exe`
    survives intact.
    """
    if not value:
        return ""
    return value.strip().strip('"').strip("'").strip()


def _find_binary(env_vars: list[str], names: list[str], candidates: list[str]) -> str | None:
    for env_var in env_vars:
        configured = _clean(os.getenv(env_var))
        if not configured:
            continue
        if Path(configured).exists():
            return configured
        # Configured but wrong: say so loudly instead of silently falling back.
        print(
            f"[capabilities] {env_var} is set to '{configured}' but no file exists there; "
            "falling back to automatic detection",
            file=sys.stderr,
        )

    for name in names:
        found = shutil.which(name)
        if found:
            return found

    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate

    return None


def _module_available(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


@functools.lru_cache(maxsize=1)
def tesseract_path() -> str | None:
    return _find_binary(
        ["TESSERACT_PATH", "TESSERACT_CMD"], ["tesseract"], TESSERACT_CANDIDATES
    )


@functools.lru_cache(maxsize=1)
def libreoffice_path() -> str | None:
    """Resolved soffice executable, or None.

    LIBREOFFICE_PATH wins when set, which is how a Windows install is pointed at
    explicitly. In Docker nothing is configured and the Linux package at
    /usr/bin/soffice is found automatically.
    """
    return _find_binary(
        ["LIBREOFFICE_PATH", "SOFFICE_CMD"], ["soffice", "libreoffice"], SOFFICE_CANDIDATES
    )


# Kept for backwards compatibility with earlier callers.
def soffice_path() -> str | None:
    return libreoffice_path()


@functools.lru_cache(maxsize=1)
def ocr_available() -> bool:
    """OCR needs both the Python wrapper and the Tesseract binary."""
    if not (_module_available("pytesseract") and _module_available("pymupdf")):
        return False
    if not tesseract_path():
        return False

    try:
        import pytesseract

        pytesseract.pytesseract.tesseract_cmd = tesseract_path()
        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


@functools.lru_cache(maxsize=1)
def capabilities() -> dict:
    """What this deployment can actually do, per format."""
    has_docx = _module_available("docx")
    has_pptx = _module_available("pptx")
    has_pymupdf = _module_available("pymupdf")
    soffice = libreoffice_path()
    has_soffice = soffice is not None
    has_ocr = ocr_available()

    def entry(available: bool, requires: str, reason: str = "") -> dict:
        return {
            "available": available,
            "requires": requires,
            **({"reason": reason} if not available and reason else {}),
        }

    missing_office = (
        "LibreOffice was not found. Install it and set LIBREOFFICE_PATH, "
        "or convert the file to DOCX/PPTX before uploading."
    )

    return {
        # Unchanged by LibreOffice: these never use it.
        ".pdf": entry(True, "pypdf (+ Tesseract only for scanned pages)"),
        ".txt": entry(True, "none"),
        ".md": entry(True, "none"),
        # Modern Office formats are read directly - faster, and it preserves
        # paragraph/slide metadata that a LibreOffice round-trip would lose.
        ".docx": entry(has_docx, "python-docx", "python-docx is not installed"),
        ".pptx": entry(has_pptx, "python-pptx", "python-pptx is not installed"),
        # Legacy binary formats are converted by LibreOffice first.
        ".doc": entry(
            has_soffice and has_docx,
            "LibreOffice + python-docx",
            missing_office if not has_soffice else "python-docx is not installed",
        ),
        ".ppt": entry(
            has_soffice and has_pptx,
            "LibreOffice + python-pptx",
            missing_office if not has_soffice else "python-pptx is not installed",
        ),
        "ocr": entry(
            has_ocr,
            "Tesseract OCR binary + pytesseract + PyMuPDF",
            "Tesseract binary not found; scanned PDFs cannot be read"
            if not tesseract_path()
            else "pytesseract/PyMuPDF unavailable",
        ),
        "pdfRender": entry(has_pymupdf, "PyMuPDF", "PyMuPDF is not installed"),
    }


def supported_extensions() -> list[str]:
    """Extensions this deployment can genuinely process right now."""
    return sorted(
        ext for ext, info in capabilities().items() if ext.startswith(".") and info["available"]
    )


def summary() -> dict:
    """Compact view for health checks."""
    return {
        "supportedExtensions": supported_extensions(),
        "ocr": ocr_available(),
        "libreOffice": libreoffice_path() is not None,
        # The resolved path helps diagnose a misconfiguration. It is only ever
        # returned to the Express backend, never to the browser.
        "libreOfficePath": libreoffice_path(),
        "tesseractPath": tesseract_path(),
    }


def reset_cache() -> None:
    """Re-probe after a dependency is installed, without restarting."""
    tesseract_path.cache_clear()
    libreoffice_path.cache_clear()
    ocr_available.cache_clear()
    capabilities.cache_clear()
