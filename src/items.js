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

module.exports = { splitItems };
