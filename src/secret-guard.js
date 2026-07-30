'use strict';
// Write-time secret BLOCK — the prevention half the redaction filter never gave.
//
// The redaction filter (privacy-scan.redact) only masks the COMMITTED .md
// PROJECTION. The canonical store — db.sqlite AND events.jsonl — keeps the
// ORIGINAL text verbatim, so a logged secret is persisted raw and rides the
// off-branch side-rail even though the shared .md is blurred. This guard runs
// BEFORE the store is touched, so an unmarked secret-shape can never enter it
// in the first place. Like a smoke detector that won't let you light the stove
// with a gas leak — not one that just records the fire after.
//
// DRY: it reuses privacy-scan's scan() and the SAME `token` (secret-shape)
// class the promote gate + the redaction mask key on. It adds NO new regex.
// Only the `token` class is blocked — high precision, the one class with no
// legitimate place in a memory store. name/network/path classes are NOT
// blocked here (too noisy for a hard write-time gate; the pre-commit/pre-push
// hook + audit-history still cover them).
//
// Escape hatches keep this from becoming a wall people disable wholesale:
//   - a line carrying the `allowlist-secret` marker is ALLOWED (deliberate
//     fixtures / known fakes), matching the existing marker convention.
//   - PEBBL_SECRET_GUARD env: `block` (default when unset) | `warn` (stderr,
//     still writes — for migration) | `off` (silent, the full escape valve).

const { scan, ALLOWLIST_MARKER } = require('./privacy-scan');

// The marker lives in privacy-scan (the shared detector) so there is exactly
// ONE definition of what an exemption looks like. scan() now also skips marked
// lines itself; the per-line check below is kept as the guard's own explicit
// contract, so this module still reads as "unmarked tokens block" on its face
// rather than depending on a detail of a module it merely calls.

// Read + normalize the guard mode. Anything unrecognized falls back to block,
// so a typo'd env never silently disables the gate.
function guardMode() {
  const raw = (process.env.PEBBL_SECRET_GUARD || '').trim().toLowerCase();
  if (raw === 'warn') return 'warn';
  if (raw === 'off') return 'off';
  return 'block'; // default when unset / unrecognized
}

// Find unmarked token-class hits across the given fields. A field is one of the
// pieces about to be persisted (a log message, or a handoff summary/done/todo/
// blocked). We scan PER FIELD and PER LINE so the `allowlist-secret` marker on
// a line exempts only that line, not the whole write. Returns [{ field, hit }].
function findUnmarkedTokens(fields) {
  const out = [];
  for (const { name, value } of fields) {
    if (value == null) continue;
    const text = String(value);
    const lines = text.split('\n');
    for (const hit of scan(text)) {
      if (hit.class !== 'token') continue; // token class ONLY
      // scan() reports a 1-based line number within `text`; an allowlist marker
      // anywhere on that line exempts the hit (deliberate fixture).
      const line = lines[hit.line - 1] || '';
      if (line.includes(ALLOWLIST_MARKER)) continue;
      out.push({ field: name, hit });
    }
  }
  return out;
}

function teachingMessage(verb, found) {
  const lines = [];
  lines.push('');
  lines.push(`pebbl ${verb}: BLOCKED — refusing to persist ${found.length} unmarked secret-shape${found.length === 1 ? '' : 's'} into the store:`);
  for (const { field, hit } of found) {
    lines.push(`  [${field}] ${hit.match}  (${hit.detail})`);
  }
  lines.push('');
  lines.push('The pebbl store (db.sqlite + events.jsonl) is the source of truth and rides the');
  lines.push('shared side-rail, where an append-only secret can never be un-leaked. Nothing was');
  lines.push('written. Pick one:');
  lines.push('  • remove or rotate the secret (best — a real secret must be rotated at its source)');
  lines.push(`  • if it is a deliberate fixture/fake, add \`${ALLOWLIST_MARKER}\` to that line`);
  lines.push('  • migrating an existing flow? set PEBBL_SECRET_GUARD=warn (writes + warns) or =off');
  return lines.join('\n');
}

// The single entry point both write paths call BEFORE any store mutation.
// `verb` is the command name for the message ('log' | 'handoff'). `fields` is
// [{ name, value }] of every text field about to be persisted.
//
// Contract:
//   - mode 'off'   : returns immediately, no scan, no output (the escape valve).
//   - clean fields : returns silently (no output) in any mode.
//   - dirty + 'warn': prints the teaching message to stderr, RETURNS (caller
//                     proceeds to write — migration mode).
//   - dirty + 'block': prints the teaching message to stderr and calls
//                     process.exit(1) — the caller never reaches its write.
// Returning (vs throwing) on warn keeps the caller's control flow simple: it
// calls guard once, then writes; block never returns.
function guardWrite(verb, fields, { exit = process.exit, log = console.error } = {}) {
  const mode = guardMode();
  if (mode === 'off') return;
  const found = findUnmarkedTokens(fields);
  if (found.length === 0) return;
  log(teachingMessage(verb, found));
  if (mode === 'warn') {
    log('pebbl: PEBBL_SECRET_GUARD=warn — writing anyway. Resolve before sharing the store.');
    return;
  }
  exit(1); // block (default): stop before any write
}

module.exports = {
  guardWrite,
  guardMode,
  findUnmarkedTokens,
  ALLOWLIST_MARKER,
};
