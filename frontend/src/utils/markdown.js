/**
 * Makes a partially-streamed Markdown string safe to render.
 *
 * A half-written fenced code block or an unclosed inline span would otherwise
 * swallow the rest of the answer until the closing marker arrives, which makes
 * the text visibly flicker between styles while streaming.
 */
export function stabilizeMarkdown(text) {
  if (!text) return '';

  let output = text;

  // Close an open fenced code block.
  const fences = output.match(/^```/gm);
  if (fences && fences.length % 2 === 1) {
    output += output.endsWith('\n') ? '```' : '\n```';
    return output;
  }

  // Close an odd number of inline backticks on the final line.
  const lastLine = output.slice(output.lastIndexOf('\n') + 1);
  const inlineTicks = (lastLine.match(/`/g) || []).length;
  if (inlineTicks % 2 === 1) output += '`';

  // Hide a dangling link/image skeleton until the closing bracket arrives.
  output = output.replace(/!?\[[^\]\n]*$/, '');

  return output;
}

export default stabilizeMarkdown;
