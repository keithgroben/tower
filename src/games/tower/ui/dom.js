/**
 * Two small helpers the windows share (issue #18). `el` builds a node without `innerHTML` (so a
 * name a player typed can never be markup); `money` is the one way a dollar amount is written.
 */

/** `el('button', { class: 'x', text: 'hi', onclick }, child...)`. */
export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node[k] = v;
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

/** `$1,234` / `-$1,234`. Whole dollars, as everything in the sim is. */
export const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
