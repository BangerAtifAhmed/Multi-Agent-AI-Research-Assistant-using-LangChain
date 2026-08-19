/**
 * Turns the backend's document status + progress counters into something the
 * UI can render.
 *
 * Everything here is derived from counts the server actually measured. When a
 * denominator is not known yet - and during a streamed ingestion it often is
 * not, because extraction and embedding overlap - `percent` is null and the UI
 * shows an indeterminate bar rather than a number that would be made up.
 *
 * Pure and DOM-free, so it can be tested with `node --test`.
 */

/** Stages in the order they happen, for the stepper. */
export const STAGES = ['uploading', 'extracting', 'ocr', 'chunking', 'embedding', 'ready'];

/** Statuses the server will not move away from on its own. */
export const TERMINAL_STATUSES = new Set(['ready', 'failed']);

const LABELS = {
  pending: 'Queued',
  uploading: 'Uploading',
  extracting: 'Extracting text',
  ocr: 'Reading scanned pages',
  chunking: 'Splitting into chunks',
  embedding: 'Generating embeddings',
  ready: 'Ready',
  failed: 'Failed',
};

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * @param {object} document  a document as returned by the API
 * @param {object} [local]   client-side state the server cannot know
 * @param {number} [local.uploadPercent]  0-100 while the file is still being sent
 * @param {boolean} [local.backgrounded]  the UI stopped waiting; work continues
 * @returns {{stage: string, label: string, detail: string|null, percent: number|null,
 *            tone: 'active'|'done'|'error', done: boolean}}
 */
export function describeProgress(document, local = {}) {
  const { uploadPercent, backgrounded } = local;
  const status = document?.status ?? 'pending';
  const progress = document?.progress ?? {};

  if (backgrounded) {
    return {
      stage: status,
      label: 'Still processing',
      detail: 'This keeps running in the background - check your Library shortly.',
      percent: null,
      tone: 'active',
      done: false,
    };
  }

  if (status === 'failed') {
    return {
      stage: 'failed',
      label: LABELS.failed,
      // The real reason from the server, never a generic message.
      detail: document?.errorMessage ?? null,
      percent: null,
      tone: 'error',
      done: true,
    };
  }

  if (status === 'ready') {
    const chunks = document?.chunkCount ?? progress.chunksTotal;
    return {
      stage: 'ready',
      label: LABELS.ready,
      detail: chunks ? `Indexed ${plural(chunks, 'chunk')}` : null,
      percent: 100,
      tone: 'done',
      done: true,
    };
  }

  // Still uploading: the browser knows exactly how many bytes have gone out.
  if (status === 'uploading' && typeof uploadPercent === 'number') {
    return {
      stage: 'uploading',
      label: LABELS.uploading,
      detail: `${Math.round(uploadPercent)}%`,
      percent: Math.max(0, Math.min(100, Math.round(uploadPercent))),
      tone: 'active',
      done: false,
    };
  }

  const stage = progress.stage && progress.stage !== 'failed' ? progress.stage : status;
  return {
    stage,
    label: LABELS[stage] ?? LABELS[status] ?? 'Processing',
    detail: describeDetail(stage, progress),
    percent: computePercent(stage, progress),
    tone: 'active',
    done: false,
  };
}

/** The counts for the current stage, or null when nothing has been measured. */
function describeDetail(stage, progress) {
  const { page, pages, ocrPages, block, blocks, batches, batchesTotal, chunks } = progress;

  if (stage === 'ocr') {
    // Page-level OCR progress is the one number that matters on a long scan.
    if (typeof page === 'number' && pages) return `page ${page} of ${pages}`;
    if (typeof ocrPages === 'number') return `${plural(ocrPages, 'page')} so far`;
    return null;
  }

  if (stage === 'extracting') {
    if (typeof page === 'number' && pages) return `page ${page} of ${pages}`;
    if (typeof block === 'number' && blocks) return `section ${block} of ${blocks}`;
    if (blocks) return plural(blocks, 'section');
    return null;
  }

  if (stage === 'embedding') {
    if (typeof batches === 'number') {
      // The denominator only exists once extraction has finished, because the
      // two run at the same time. Until then the count stands on its own.
      const suffix = batchesTotal ? ` of ${batchesTotal}` : '';
      return `batch ${batches}${suffix}`;
    }
    if (typeof chunks === 'number') return `${plural(chunks, 'chunk')} indexed`;
    return null;
  }

  if (stage === 'chunking' && typeof chunks === 'number') {
    return `${plural(chunks, 'chunk')} so far`;
  }

  return null;
}

/**
 * A percentage only when a real ratio exists. Returns null otherwise, which the
 * UI renders as an indeterminate bar - deliberately, rather than inventing a
 * number that would move without meaning anything.
 */
function computePercent(stage, progress) {
  const { page, pages, batches, batchesTotal, block, blocks } = progress;

  if ((stage === 'ocr' || stage === 'extracting') && pages && typeof page === 'number') {
    return clamp((page / pages) * 100);
  }
  if (stage === 'embedding' && batchesTotal && typeof batches === 'number') {
    return clamp((batches / batchesTotal) * 100);
  }
  if (stage === 'extracting' && blocks && typeof block === 'number') {
    return clamp((block / blocks) * 100);
  }
  return null;
}

const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)));

/** Index of the current stage in STAGES, for a stepper. -1 when unknown. */
export const stageIndex = (stage) => STAGES.indexOf(stage);

export default { describeProgress, STAGES, TERMINAL_STATUSES, stageIndex };
