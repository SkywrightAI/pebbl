'use strict';
// Write-time PII substitution — the "name remover".
//
// The problem it solves, found the hard way: lumr's store carries four entries
// naming a real BookForge user, written months ago, and append-only memory
// cannot take them back. Every guard pebbl had ran too late to help. The
// pre-commit scan catches a name only if a name-map exists (lumr had none, so
// the whole PII class was blind), and even when it fires, the entry is already
// in events.jsonl — the scan can refuse the COMMIT, but the text is already
// persisted and un-erasable.
//
// So this runs BEFORE the store is touched, at the same seam secret-guard uses.
// A smoke detector that won't let you light the stove, not one that files a
// report after the fire.
//
// SUBSTITUTE, don't block. secret-guard blocks a token because a leaked
// credential has no legitimate form in a memory store. A real name is different:
// the ENTRY is worth keeping and only the name is not. Blocking would make the
// author choose between losing the memory and editing around the guard, and in
// practice people pick "don't write it down" — which costs the project the
// decision AND leaves the habit unchanged. Substitution keeps the knowledge and
// drops the identity.
//
// LOUD, never silent. Rewriting what someone typed is a real liberty, so every
// substitution is printed. The pseudonym is stable (it comes from the map), so
// the entry stays readable and searchable under a consistent alias, and the
// mapping back to the real person stays in the gitignored name-map — the one
// store file that must never be committed.

const { loadNameMap } = require('./privacy-scan');

// Escape a name for use inside a regex (names can contain . ( ) etc.).
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest names first, so "Cordelia Vance" is replaced as a whole rather than
// leaving a bare "Vance" behind after "Cordelia" matched on its own. Substring
// PII is worse than none: a half-anonymised name reads as anonymised.
function orderedPairs(map) {
  return Object.entries(map)
    .filter(([real, pseudo]) => typeof real === 'string' && real.trim().length > 2 && pseudo)
    .sort((a, b) => b[0].length - a[0].length);
}

// Replace every mapped real name in `text` with its pseudonym.
// PURE: returns { text, subs: [{ real, pseudonym, count }] }. No I/O, no exit.
//
// Matching is case-insensitive with non-alphanumeric boundaries, mirroring
// privacy-scan.findNames so the guard and the scanner can never disagree about
// what counts as a mention.
// Match the pseudonym to the case the real name was written in.
//
// Matching is case-insensitive, so a map cannot hold case-distinct entries for
// the same name — "Gabriel" and the username "gabriel" are one key, and whichever
// sorted first would win for both. Without this, "droplet user gabriel" becomes
// "droplet user Rowan", which reads as a person where the text meant an account.
// Deriving case from the MATCH removes the need for duplicate entries entirely.
function matchCase(matched, pseudonym) {
  if (matched === matched.toLowerCase()) return pseudonym.toLowerCase();
  if (matched === matched.toUpperCase() && /[A-Z]{2,}/.test(matched)) return pseudonym.toUpperCase();
  return pseudonym;
}

function substituteNames(text, map) {
  if (text == null) return { text, subs: [] };
  let out = String(text);
  const subs = [];
  for (const [real, pseudonym] of orderedPairs(map)) {
    const re = new RegExp(`(^|[^A-Za-z0-9])(${escapeRe(real)})([^A-Za-z0-9]|$)`, 'gi');
    let count = 0;
    // Loop rather than a single replace: overlapping boundary groups mean one
    // pass can miss adjacent mentions ("Gabe and Gabe"), because the trailing
    // boundary of the first match is the leading boundary of the second.
    let prev;
    do {
      prev = out;
      out = out.replace(re, (m, a, hit, c) => { count += 1; return `${a}${matchCase(hit, pseudonym)}${c}`; });
    } while (out !== prev);
    if (count > 0) subs.push({ real, pseudonym, count });
  }
  return { text: out, subs };
}

// Mode, read the same way secret-guard reads its own: anything unrecognized
// falls back to the safe default, so a typo'd env never silently disables it.
//   substitute (default) — swap real names for pseudonyms, print what changed
//   block                — refuse the write instead (for a store that must never
//                          contain even a pseudonymised reference)
//   off                  — no PII handling at all
function nameGuardMode() {
  const raw = (process.env.PEBBL_NAME_GUARD || '').trim().toLowerCase();
  if (raw === 'block') return 'block';
  if (raw === 'off') return 'off';
  return 'substitute';
}

function report(verb, subs, log) {
  const lines = [''];
  lines.push(`pebbl ${verb}: substituted ${subs.length} real name${subs.length === 1 ? '' : 's'} before writing:`);
  for (const s of subs) {
    lines.push(`  ${s.real} -> ${s.pseudonym}${s.count > 1 ? `  (${s.count} mentions)` : ''}`);
  }
  lines.push('');
  lines.push('The store is append-only and this one is shared, so a real name written here');
  lines.push('could never be taken back. The mapping stays in your gitignored name-map.');
  return lines.join('\n');
}

// Guard a set of {name, value} fields about to be persisted. Returns the fields
// with names substituted; prints what changed. Callers MUST use the returned
// fields — the substitution is the point.
//
// Degrades to a no-op when no name-map exists, which is the common case and must
// never be an error: a repo without a map still gets every other guard.
function guardNames(verb, fields, { exit = process.exit, log = console.error, opts = {} } = {}) {
  const mode = nameGuardMode();
  if (mode === 'off') return fields;
  const map = loadNameMap(opts);
  if (!map || Object.keys(map).length === 0) return fields;

  const all = [];
  const out = fields.map((f) => {
    if (f.value == null) return f;
    const { text, subs } = substituteNames(String(f.value), map);
    all.push(...subs);
    return subs.length ? { ...f, value: text } : f;
  });
  if (all.length === 0) return fields;

  if (mode === 'block') {
    log(report(verb, all, log).replace('substituted', 'BLOCKED — found'));
    log('PEBBL_NAME_GUARD=block: refusing the write. Use a pseudonym, or unset to substitute.');
    exit(1);
    return fields;
  }
  log(report(verb, all, log));
  return out;
}

module.exports = { guardNames, substituteNames, nameGuardMode, _internal: { orderedPairs } };
