import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { stabilizeMarkdown } from '../utils/markdown.js';

const components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node, ...props }) => (
    <div className="table-wrap">
      <table {...props} />
    </div>
  ),
};

/**
 * Renders assistant Markdown, including while it is still streaming.
 * `stabilizeMarkdown` closes half-written code fences so the layout does not
 * flicker between plain text and a code block as tokens arrive.
 */
function MarkdownRenderer({ content, streaming = false }) {
  const source = streaming ? stabilizeMarkdown(content) : content;

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownRenderer);
