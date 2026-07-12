'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { ensureProjectFiles } = require('./rubric');

// `pebbl check` — flag memory entries that cite a file/symbol that no longer
// exists, so recall stays trustworthy. A confidently-wrong entry sends an
// agent down a false path with borrowed authority — worse than no memory.
// REPORT ONLY: never edits or deletes; it points at `--corrects`.

// Known source/text extensions. A path token must carry one to count as a
// HIGH-confidence file reference — this is what keeps the checker quiet enough
// to be trusted (a noisy checker gets ignored, like the thin-entry warning).
const PATH_EXT =
  'js|ts|jsx|tsx|mjs|cjs|sh|bash|py|rb|go|rs|java|kt|c|h|cc|cpp|md|json|ya?ml|toml|sql|txt|html|css|scss|conf|cfg|ini|env|lock';

// Path-like tokens: a slash plus a known extension, repo-relative (not
// absolute, not ~home, not a URL — those can't be verified against this repo).
// Defensive regex sweep over the message, the style of context.js
// findRelatedCommits.
function extractPaths(message) {
  const text = String(message || '').replace(/https?:\/\/\S+/g, ' '); // URLs aren't repo paths
  const re = new RegExp(
    `(?:^|[\\s\\\`'"(\\[])(\\.?[\\w.@-]*(?:/[\\w.@-]+)+\\.(?:${PATH_EXT}))(?=$|[\\s\\\`'".,;:)\\]])`,
    'g'
  );
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const tok = m[1];
    if (tok.startsWith('/') || tok.startsWith('~')) continue; // not repo-relative
    // Prose artifact, not a path: "LOOP.md/AGENTS.md" or "pyproject.toml/uv.lock"
    // is two FILENAMES joined by a slash-as-"or", so an INTERIOR segment carries
    // a file extension. A real directory named `*.md`/`*.toml` is vanishingly
    // rare; skipping these keeps the checker quiet enough to be trusted (its
    // design bar) instead of flagging a "file" that never existed.
    const segs = tok.split('/');
    const interiorExt = new RegExp(`\\.(?:${PATH_EXT})$`);
    if (segs.slice(0, -1).some(s => interiorExt.test(s))) continue;
    out.add(tok);
  }
  return [...out];
}

// Absolute directory paths NAMED in the message ("repo /abs/path", "at
// /abs/path", or any absolute/~-home path token). A cross-repo entry — one
// logged in THIS store about ANOTHER repo — cites relative paths that resolve
// against the repo it names, not against this store's root. These tokens are
// the candidate extra roots checkEntries resolves against, so such an entry is
// only flagged when the file exists in NEITHER location. Tokens that carry a
// known file extension are file citations, not roots, and are skipped; ~ is
// expanded to the home dir. Existence-as-a-directory is checked at resolve
// time (externalRootsOf below), not here, so this stays a pure token scan.
function extractRepoRoots(message) {
  const text = String(message || '').replace(/https?:\/\/\S+/g, ' '); // URLs aren't repo paths
  // ≥2 segments for /abs (so a bare "/tmp" or a stray leading slash doesn't
  // become a root), ≥1 segment for ~-home. Same boundary class extractPaths uses.
  const re = /(?:^|[\s`'"(\[])((?:~|\/[\w.@-]+)(?:\/[\w.@-]+)+)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    // Strip trailing sentence punctuation ("… repo /a/b/harold.") — internal
    // dots ("10.Code-Projects") survive because only the tail is trimmed.
    const tok = m[1].replace(/[.,;:]+$/, '');
    if (new RegExp(`\\.(?:${PATH_EXT})$`).test(tok)) continue; // a file, not a root
    out.add(tok.startsWith('~') ? path.join(os.homedir(), tok.slice(1)) : tok);
  }
  return [...out];
}

function isDir(r) {
  try {
    return fs.statSync(r).isDirectory();
  } catch {
    return false;
  }
}

// A root plus its src/ subdirectory when one exists. Entries routinely cite a
// repo's files without the src/ prefix ("capabilities/claim.ts" for
// src/capabilities/claim.ts) — and that shorthand is just as common for the
// STORE'S OWN repo as for a named external one (the loom store's own entries
// cite "capabilities/queue.ts", "foundation/jsonstore.ts"). ONE helper shared
// by the own-root and named-root resolution so the two cannot drift (DRY).
function withSrc(root) {
  const out = [root];
  const src = path.join(root, 'src');
  if (isDir(src)) out.push(src);
  return out;
}

// The named roots that actually EXIST as directories on this machine (a token
// that isn't a real directory can't hide a missing file, so it's dropped).
// For each named root we ALSO try its src/ subdirectory when one exists
// (withSrc above — same shorthand rule the store's own root gets).
function externalRootsOf(message) {
  const out = [];
  for (const r of extractRepoRoots(message)) {
    if (!isDir(r)) continue;
    out.push(...withSrc(r));
  }
  return out;
}

// Backtick-wrapped identifiers/calls (`foo`, `myFunc()`) for the opt-in --deep
// symbol grep.
function extractSymbols(message) {
  const out = new Set();
  const re = /`([A-Za-z_$][\w$]{2,})\(?\)?`/g;
  let m;
  while ((m = re.exec(String(message || ''))) !== null) out.add(m[1]);
  return [...out];
}

function symbolExists(repoRoot, sym) {
  try {
    execSync('git grep -qIF -- ' + shq(sym), { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false; // not found, or not a git repo → treat as absent under --deep
  }
}
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const TIER_RANK = { foundation: 0, component: 1, detail: 2, fleeting: 3 };

// Pure: entries + repo root → flagged entries (missing paths, plus missing
// symbols when deep), highest-tier then newest first. Mutates nothing.
//
// Cross-repo resolution: when an entry NAMES another repo by absolute path
// ("repo /Users/x/harold" citing src/lib.rs), its relative paths resolve
// against that named root TOO — a citation is "missing" only when it exists in
// NO candidate root. The store's own repoRoot gets the same src/-shorthand
// fallback (withSrc): a src-layout repo's entries cite "capabilities/queue.ts"
// for src/capabilities/queue.ts, and flagging those as missing was a standing
// false positive against the store's own tree (the 2026-07-12 loom triage).
function checkEntries(entries, repoRoot, { deep = false } = {}) {
  const ownRoots = withSrc(repoRoot);
  const flagged = [];
  for (const e of entries) {
    const roots = [...ownRoots, ...externalRootsOf(e.message)];
    const missingPaths = extractPaths(e.message)
      .filter(p => !roots.some(r => fs.existsSync(path.resolve(r, p))));
    const missingSymbols = deep
      ? extractSymbols(e.message).filter(s => !roots.some(r => symbolExists(r, s)))
      : [];
    if (missingPaths.length || missingSymbols.length) {
      flagged.push({ ...e, missingPaths, missingSymbols });
    }
  }
  flagged.sort((a, b) =>
    ((TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9)) ||
    String(b.timestamp).localeCompare(String(a.timestamp)));
  return flagged;
}

module.exports = function check(args) {
  const { flags } = parseArgs(args);
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  const repoRoot = path.dirname(path.resolve(pebblDir));
  const db = openDb(pebblDir);
  const entries = db.prepare(
    "SELECT id, timestamp, category, tier, message FROM logs WHERE tier != 'archived' ORDER BY timestamp DESC"
  ).all();
  const flagged = checkEntries(entries, repoRoot, { deep: !!flags.deep });

  if (flagged.length === 0) {
    console.log(`pebbl check: no entry cites a missing file${flags.deep ? ' or symbol' : ''}. Memory looks trustworthy.`);
    return;
  }

  const noun = flagged.length === 1 ? 'entry cites a' : 'entries cite';
  console.log(`\npebbl check — ${flagged.length} ${noun} missing artifact (report only, nothing changed):\n`);
  for (const e of flagged) {
    const date = String(e.timestamp || '').slice(0, 10);
    const msg = e.message.length > 100 ? e.message.slice(0, 100) + '…' : e.message;
    console.log(`#${e.id} [${e.tier}|${e.category}] ${date} — ${msg}`);
    if (e.missingPaths.length) console.log(`   missing path: ${e.missingPaths.join(', ')}`);
    if (e.missingSymbols.length) console.log(`   missing symbol: ${e.missingSymbols.join(', ')}`);
    console.log(`   if wrong, supersede:  pebbl log "<corrected memory>" --corrects ${e.id}`);
    console.log();
  }
};

module.exports._internal = { extractPaths, extractSymbols, extractRepoRoots, externalRootsOf, checkEntries, TIER_RANK };
