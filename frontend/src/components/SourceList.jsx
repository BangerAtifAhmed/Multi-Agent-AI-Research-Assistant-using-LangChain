import { memo, useState } from 'react';

import SourceCard from './SourceCard.jsx';

function SourceList({ sources }) {
  const [open, setOpen] = useState(false);

  if (!sources?.length) return null;

  return (
    <div className="sources">
      <button
        type="button"
        className="sources__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={`sources__caret ${open ? 'is-open' : ''}`} aria-hidden="true">
          ▸
        </span>
        {sources.length} source{sources.length === 1 ? '' : 's'}
      </button>

      {open && (
        <div className="sources__grid">
          {sources.map((source) => (
            <SourceCard key={`${source.index}-${source.url || source.page}`} source={source} />
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(SourceList);
