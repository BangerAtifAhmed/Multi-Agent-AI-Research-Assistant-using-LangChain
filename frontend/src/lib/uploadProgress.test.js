/**
 * Progress-state tests.
 *
 *   npm test        (node --test, no extra tooling)
 *
 * The rule being enforced throughout: a percentage appears only when the server
 * reported both a numerator and a denominator. Anything else stays null so the
 * UI shows an indeterminate bar instead of a number that means nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeProgress, stageIndex, STAGES } from './uploadProgress.js';

describe('uploading', () => {
  it('reports the real byte percentage', () => {
    const state = describeProgress({ status: 'uploading' }, { uploadPercent: 35 });
    assert.equal(state.label, 'Uploading');
    assert.equal(state.detail, '35%');
    assert.equal(state.percent, 35);
    assert.equal(state.done, false);
  });

  it('clamps and rounds a noisy percentage', () => {
    assert.equal(describeProgress({ status: 'uploading' }, { uploadPercent: 34.6 }).percent, 35);
    assert.equal(describeProgress({ status: 'uploading' }, { uploadPercent: -5 }).percent, 0);
    assert.equal(describeProgress({ status: 'uploading' }, { uploadPercent: 140 }).percent, 100);
  });

  it('stays indeterminate when the browser cannot measure the upload', () => {
    const state = describeProgress({ status: 'uploading' });
    assert.equal(state.percent, null);
  });
});

describe('extracting', () => {
  it('shows page progress for a PDF, with a real ratio', () => {
    const state = describeProgress({
      status: 'extracting',
      progress: { stage: 'extracting', page: 140, pages: 560 },
    });
    assert.equal(state.label, 'Extracting text');
    assert.equal(state.detail, 'page 140 of 560');
    assert.equal(state.percent, 25);
  });

  it('shows section progress for formats without pages', () => {
    const state = describeProgress({
      status: 'extracting',
      progress: { stage: 'extracting', block: 3, blocks: 7 },
    });
    assert.equal(state.detail, 'section 3 of 7');
    assert.equal(state.percent, 43);
  });

  it('has no percentage before any count arrives', () => {
    const state = describeProgress({ status: 'extracting', progress: { stage: 'extracting' } });
    assert.equal(state.detail, null);
    assert.equal(state.percent, null);
  });
});

describe('ocr', () => {
  it('shows page N of M, the number that matters on a long scan', () => {
    const state = describeProgress({
      status: 'ocr',
      progress: { stage: 'ocr', page: 42, pages: 180, ocrPages: 7 },
    });
    assert.equal(state.label, 'Reading scanned pages');
    assert.equal(state.detail, 'page 42 of 180');
    assert.equal(state.percent, 23);
  });

  it('falls back to a bare count when the total is unknown', () => {
    const state = describeProgress({ status: 'ocr', progress: { stage: 'ocr', ocrPages: 3 } });
    assert.equal(state.detail, '3 pages so far');
    assert.equal(state.percent, null);
  });

  it('says "1 page" rather than "1 pages"', () => {
    const state = describeProgress({ status: 'ocr', progress: { stage: 'ocr', ocrPages: 1 } });
    assert.equal(state.detail, '1 page so far');
  });
});

describe('embedding', () => {
  it('shows batch N of M once extraction has finished', () => {
    const state = describeProgress({
      status: 'embedding',
      progress: { stage: 'embedding', batches: 8, batchesTotal: 32, chunks: 512 },
    });
    assert.equal(state.label, 'Generating embeddings');
    assert.equal(state.detail, 'batch 8 of 32');
    assert.equal(state.percent, 25);
  });

  it('omits the denominator while extraction is still running', () => {
    // Extraction and embedding overlap, so the total genuinely is not known
    // yet. Showing "batch 8 of 8" here would be a lie.
    const state = describeProgress({
      status: 'embedding',
      progress: { stage: 'embedding', batches: 8, chunks: 512 },
    });
    assert.equal(state.detail, 'batch 8');
    assert.equal(state.percent, null);
  });

  it('falls back to a chunk count when no batch number exists', () => {
    const state = describeProgress({
      status: 'embedding',
      progress: { stage: 'embedding', chunks: 64 },
    });
    assert.equal(state.detail, '64 chunks indexed');
  });
});

describe('terminal states', () => {
  it('reports ready with what was actually indexed', () => {
    const state = describeProgress({ status: 'ready', chunkCount: 1120, progress: {} });
    assert.equal(state.label, 'Ready');
    assert.equal(state.detail, 'Indexed 1120 chunks');
    assert.equal(state.percent, 100);
    assert.equal(state.tone, 'done');
    assert.equal(state.done, true);
  });

  it('reports failure with the server error, not a generic one', () => {
    const state = describeProgress({
      status: 'failed',
      errorMessage: 'OCR failed on page 42: tesseract exited with 1',
      progress: { stage: 'failed' },
    });
    assert.equal(state.tone, 'error');
    assert.equal(state.detail, 'OCR failed on page 42: tesseract exited with 1');
    assert.equal(state.done, true);
    assert.equal(state.percent, null);
  });

  it('never invents a percentage for a failed document', () => {
    const state = describeProgress({
      status: 'failed',
      errorMessage: 'boom',
      // Stale counters from before the failure must not drive a bar.
      progress: { stage: 'embedding', batches: 4, batchesTotal: 32 },
    });
    assert.equal(state.percent, null);
  });
});

describe('backgrounded', () => {
  it('says the work continues after the UI stops waiting', () => {
    const state = describeProgress(
      { status: 'embedding', progress: { stage: 'embedding', batches: 8 } },
      { backgrounded: true },
    );
    assert.equal(state.label, 'Still processing');
    assert.match(state.detail, /background/i);
    assert.equal(state.done, false);
    assert.equal(state.tone, 'active');
  });
});

describe('robustness', () => {
  it('handles a document with no progress field at all', () => {
    // Rows written before the progress column existed.
    const state = describeProgress({ status: 'extracting' });
    assert.equal(state.label, 'Extracting text');
    assert.equal(state.percent, null);
  });

  it('handles a missing document', () => {
    const state = describeProgress(undefined);
    assert.equal(state.stage, 'pending');
    assert.equal(state.done, false);
  });

  it('prefers the progress stage over a lagging status column', () => {
    const state = describeProgress({
      status: 'extracting',
      progress: { stage: 'ocr', page: 2, pages: 4 },
    });
    assert.equal(state.stage, 'ocr');
    assert.equal(state.percent, 50);
  });

  it('orders the stages the pipeline actually follows', () => {
    assert.deepEqual(STAGES, ['uploading', 'extracting', 'ocr', 'chunking', 'embedding', 'ready']);
    assert.ok(stageIndex('embedding') > stageIndex('extracting'));
    assert.equal(stageIndex('nonsense'), -1);
  });
});

describe('every supported format reports something useful', () => {
  // What each format's extractor actually measures, from the Python side.
  const cases = [
    ['.pdf', { stage: 'extracting', page: 40, pages: 100 }, 'page 40 of 100'],
    ['.pdf scanned', { stage: 'ocr', page: 3, pages: 10, ocrPages: 3 }, 'page 3 of 10'],
    ['.docx', { stage: 'extracting', block: 2, blocks: 6 }, 'section 2 of 6'],
    ['.doc', { stage: 'extracting', block: 5, blocks: 7 }, 'section 5 of 7'],
    ['.pptx', { stage: 'extracting', block: 1, blocks: 3 }, 'section 1 of 3'],
    ['.ppt', { stage: 'extracting', block: 3, blocks: 3 }, 'section 3 of 3'],
    ['.md', { stage: 'extracting', block: 2, blocks: 3 }, 'section 2 of 3'],
    ['.txt', { stage: 'embedding', batches: 1, batchesTotal: 1 }, 'batch 1 of 1'],
  ];

  for (const [format, progress, expected] of cases) {
    it(`${format} produces a meaningful detail line`, () => {
      const state = describeProgress({ status: progress.stage, progress });
      assert.equal(state.detail, expected);
      assert.equal(typeof state.percent, 'number');
    });
  }
});
