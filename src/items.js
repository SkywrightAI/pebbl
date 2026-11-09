'use strict';

// Split a handoff field (done/todo/blocked) into atomic items on ';'.
//
// Only a TOP-LEVEL ';' separates items. A ';' inside (), [], {}, "..." or
// `...` belongs to the item — proxy-magic handoff #2 wrote
// "OpenAI key fixed (set-key; the 401 was ...)" and the old plain split turned
// it into two broken half-items. Apostrophes are not quotes (owner's, don't).
// A stray ')' is ignored (numbered lists: "1) first; 2) second"), and if a
// bracket or quote never closes, the whole field falls back to a plain split
// so one typo can't glue every later item together.
//
// One definition shared by handoff.js, view.js and context.js so the stored
// field, handoffs.md and the context display always agree on item boundaries.
const OPEN = { '(': ')', '[': ']', '{': '}' };
const QUOTES = new Set(['"', '`']);

function splitItems(field) {
  if (!field) return [];
  const s = String(field);
  const items = [];
  const stack = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (QUOTES.has(ch)) quote = ch;
    else if (OPEN[ch]) stack.push(OPEN[ch]);
    else if (stack.length && ch === stack[stack.length - 1]) stack.pop();
    else if (ch === ';' && stack.length === 0) {
      items.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (quote || stack.length) return plainSplit(s);
  items.push(s.slice(start));
  return items.map((x) => x.trim()).filter(Boolean);
}

function plainSplit(s) {
  return s.split(';').map((x) => x.trim()).filter(Boolean);
}

// Clip an item to `max` chars for a field that caps item length (handoff's
// carried todos: a legacy item longer than the cap carries clipped, and its
// "from #N: " prefix already names the handoff that holds the full text).
// The cut never leaves a bracket or quote open — splitItems would then fall
// back to a plain ';' split for the WHOLE field — so it backs up to before
// the earliest unmatched opener, then appends '…'.
function clipItem(item, max) {
  const s = String(item == null ? '' : item);
  if (s.length <= max) return s;
  let cut = s.slice(0, Math.max(0, max - 1));
  const open = unmatchedOpener(cut);
  if (open !== -1) cut = cut.slice(0, open);
  return cut.trimEnd() + '…';
}

// Index of the earliest bracket or quote in `s` that is never closed, or -1.
// Same scanner rules as splitItems (apostrophes are not quotes; a stray
// closer is ignored).
function unmatchedOpener(s) {
  const stack = [];
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote.ch) quote = null;
      continue;
    }
    if (QUOTES.has(ch)) quote = { ch, i };
    else if (OPEN[ch]) stack.push({ close: OPEN[ch], i });
    else if (stack.length && ch === stack[stack.length - 1].close) stack.pop();
  }
  const candidates = [];
  if (quote) candidates.push(quote.i);
  if (stack.length) candidates.push(stack[0].i);
  return candidates.length ? Math.min(...candidates) : -1;
}

module.exports = { splitItems, clipItem };
