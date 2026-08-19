/**
 * Render-level checks for the progress widget.
 *
 * Run through `npm test`, which transpiles the JSX first (see scripts/jsx-test).
 * These cover what the pure progress tests cannot: that a known ratio renders a
 * real progressbar with aria-valuenow, and an unknown one renders an
 * indeterminate bar with no value at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import ProcessingProgress from './ProcessingProgress.jsx';

const render = (props) => renderToStaticMarkup(<ProcessingProgress {...props} />);

describe('ProcessingProgress', () => {
  it('renders OCR page progress with a real aria value', () => {
    const html = render({
      document: { status: 'ocr', progress: { stage: 'ocr', page: 42, pages: 180 } },
    });
    assert.match(html, /Reading scanned pages: page 42 of 180/);
    assert.match(html, /role="progressbar"/);
    assert.match(html, /aria-valuenow="23"/);
    assert.match(html, /width:23%/);
  });

  it('renders embedding batch progress', () => {
    const html = render({
      document: {
        status: 'embedding',
        progress: { stage: 'embedding', batches: 8, batchesTotal: 32 },
      },
    });
    assert.match(html, /Generating embeddings: batch 8 of 32/);
    assert.match(html, /aria-valuenow="25"/);
  });

  it('renders an indeterminate bar when no ratio is known', () => {
    const html = render({
      document: { status: 'embedding', progress: { stage: 'embedding', batches: 8 } },
    });
    assert.match(html, /progress__track--indeterminate/);
    // No aria-valuenow is precisely what marks a progressbar indeterminate.
    assert.doesNotMatch(html, /aria-valuenow/);
    assert.doesNotMatch(html, /width:/);
  });

  it('shows upload percentage from real bytes sent', () => {
    const html = render({ document: { status: 'uploading' }, uploadPercent: 35 });
    assert.match(html, /Uploading: 35%/);
    assert.match(html, /aria-valuenow="35"/);
  });

  it('drops the bar entirely once the document is ready', () => {
    const html = render({ document: { status: 'ready', chunkCount: 1120 } });
    assert.match(html, /Ready: Indexed 1120 chunks/);
    assert.doesNotMatch(html, /role="progressbar"/);
  });

  it('shows the server error on failure and no bar', () => {
    const html = render({
      document: { status: 'failed', errorMessage: 'OCR failed on page 42' },
    });
    assert.match(html, /progress--error/);
    assert.match(html, /OCR failed on page 42/);
    assert.doesNotMatch(html, /role="progressbar"/);
  });

  it('says work continues when the UI stops waiting', () => {
    const html = render({
      document: { status: 'embedding', progress: { stage: 'embedding' } },
      backgrounded: true,
    });
    assert.match(html, /Still processing/);
    assert.match(html, /background/i);
  });

  it('announces politely for screen readers', () => {
    const html = render({ document: { status: 'extracting', progress: { stage: 'extracting' } } });
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
  });
});
