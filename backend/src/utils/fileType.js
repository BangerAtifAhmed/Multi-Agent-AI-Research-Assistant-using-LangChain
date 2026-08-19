import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Content-based file type detection.
 *
 * The extension and the browser-supplied MIME type are both attacker-controlled,
 * so the real check is the file's own magic bytes. A ".pdf" that is actually a
 * ZIP, or a ".docx" that is actually an executable, is rejected here before any
 * parser touches it.
 */

const SIGNATURES = [
  { kind: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { kind: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK.. (OOXML: docx/pptx)
  { kind: 'zip', bytes: [0x50, 0x4b, 0x05, 0x06] }, // empty archive
  { kind: 'zip', bytes: [0x50, 0x4b, 0x07, 0x08] }, // spanned archive
  // OLE2 compound file: legacy .doc / .ppt / .xls
  { kind: 'ole2', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

// Formats that must never be accepted regardless of extension.
const DANGEROUS = [
  { label: 'Windows executable', bytes: [0x4d, 0x5a] }, // MZ
  { label: 'ELF executable', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { label: 'Mach-O executable', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { label: 'Java class file', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { label: 'shell script', bytes: [0x23, 0x21] }, // #!
];

/** Which container each extension must be stored in. */
const EXPECTED_CONTAINER = {
  '.pdf': 'pdf',
  '.docx': 'zip',
  '.pptx': 'zip',
  '.doc': 'ole2',
  '.ppt': 'ole2',
  '.txt': 'text',
  '.md': 'text',
};

const startsWith = (buffer, bytes) =>
  bytes.every((byte, index) => buffer[index] === byte);

/** Heuristic: decodes as UTF-8 and contains no NUL bytes. */
function looksLikeText(buffer) {
  if (buffer.includes(0)) return false;
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (decoded.includes('�')) return false;
  // Reject a high proportion of control characters (binary in disguise).
  let control = 0;
  for (const char of decoded) {
    const code = char.codePointAt(0);
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return control / Math.max(decoded.length, 1) < 0.05;
}

/** Reads the leading bytes and classifies the container. */
export async function detectFileType(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
    const head = buffer.subarray(0, bytesRead);

    for (const entry of DANGEROUS) {
      if (startsWith(head, entry.bytes)) {
        return { kind: 'executable', label: entry.label, dangerous: true };
      }
    }

    for (const signature of SIGNATURES) {
      if (startsWith(head, signature.bytes)) return { kind: signature.kind };
    }

    if (bytesRead === 0) return { kind: 'empty' };
    if (looksLikeText(head)) return { kind: 'text' };

    return { kind: 'unknown' };
  } finally {
    await handle.close();
  }
}

/**
 * Validates that extension, declared MIME type and actual bytes agree.
 * Returns { ok } or { ok:false, code, message }.
 */
export async function validateFileContent(filePath, originalName, allowedExtensions) {
  const extension = path.extname(originalName || '').toLowerCase();

  if (!allowedExtensions.includes(extension)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_FILE_TYPE',
      message: `Unsupported file type "${extension || 'unknown'}". Supported: ${allowedExtensions
        .join(', ')
        .toUpperCase()}.`,
    };
  }

  const detected = await detectFileType(filePath);

  if (detected.dangerous) {
    return {
      ok: false,
      code: 'DANGEROUS_FILE',
      message: `This file is a ${detected.label}, not a document. Upload rejected.`,
    };
  }

  if (detected.kind === 'empty') {
    return { ok: false, code: 'EMPTY_FILE', message: 'This file is empty.' };
  }

  const expected = EXPECTED_CONTAINER[extension];

  // Text formats are permissive by nature, but must still not be binary.
  if (expected === 'text') {
    if (detected.kind !== 'text') {
      return {
        ok: false,
        code: 'CONTENT_MISMATCH',
        message: 'This file is not readable text.',
      };
    }
    return { ok: true, detected: detected.kind };
  }

  if (detected.kind !== expected) {
    return {
      ok: false,
      code: 'CONTENT_MISMATCH',
      message:
        `This file does not look like a real ${extension.slice(1).toUpperCase()} document ` +
        '(its contents do not match its extension). It may be corrupted or renamed.',
    };
  }

  return { ok: true, detected: detected.kind };
}

export default { detectFileType, validateFileContent };
