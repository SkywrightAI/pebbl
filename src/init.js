'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { openDb } = require('./db');
const { DEFAULT_RUBRIC, DEFAULT_CONFIG } = require('./rubric');
const { detectRemoteVisibility } = require('./privacy-scan');
// DRY: the positive completeness marker name is owned by store-mode.js (its
// reader); shared init writes it so storeMode() classifies a fresh shared store
// as 'events' without depending on a per-read git spawn.
const { EVENTS_CANONICAL_MARKER } = require('./store-mode');

const AGENT_BEGIN = '<!-- pebbl:begin -->';
const AGENT_END = '<!-- pebbl:end -->';

const AGENT_SECTION = `
${AGENT_BEGIN}
## Pebbl — Memory

Local CLI for project memory. Flag details: \`pebbl <cmd> --help\`. Concepts: \`pebbl help <topic>\` (categories, tiers, compaction, file-layout, entry-ids).

**Every session, before code:** \`pebbl context\` (read open handoff + recent decisions). An open handoff's \`done\` field is what the *previous* agent finished — don't claim it as your own. The \`todo\` field is what's left for you. Close the handoff with \`pebbl handoff --close\` when you complete the remaining work.

**Before any non-trivial decision:** \`pebbl search "<area>"\` — don't re-litigate prior choices.

**Log the moment a decision or failed approach lands.** Always include \`--cat\` and \`--topic\`. Always explain *why*, not just *what* — entries without rationale get auto-demoted.

\`\`\`bash
pebbl log "chose bcrypt over argon2 because team already operates bcrypt in prod" --cat decision --topic auth
\`\`\`

**End of session:** \`pebbl handoff "<summary>" --done "a; b" --todo "c; d" --topic <area>\`. Use \`;\` to split atomic items — one run-on becomes one unsearchable blob.

**A detail-heavy handoff needs a rendered doc.** When the end-of-session detail is large, write it to a readable file (e.g. \`docs/handoffs/<topic>.md\`) and link it with \`--docs <path>\` — the fields are for searchable one-liners, the doc is the readable detail. pebbl REFUSES a detail-heavy handoff that links neither \`--docs\` nor \`--no-doc\`, so the rendered doc reliably gets made instead of the detail being crammed into the fields or written somewhere and never linked. The linked doc resurfaces on \`pebbl context\`.

**Don't log:** routine code changes (the git hook captures commits), or anything obvious from reading the code.
${AGENT_END}
`;

const AGENT_STANDALONE = `# Agent Guidelines\n${AGENT_SECTION}`;

// post-commit hook. Captures the commit into pebbl memory: `pebbl log-commit`
// writes the commit + log rows and appends commit-log.md so the commit is
// searchable.
//
// PINNING (same pattern as the P5 hooks below): the hook bakes in the ABSOLUTE
// path of the bin/pebbl.js that ran `init`, invoked via `node`, so it ALWAYS runs
// the pebbl that installed it — not whatever `pebbl` is first on $PATH. Falls back
// to a PATH `pebbl` only if the pinned bin is gone. Keep this template in sync
// with src/upgrade.js.
function postCommitHook(pinnedBin) {
  const pin = String(pinnedBin).replace(/'/g, `'\\''`); // shell-safe single-quote
  return `#!/bin/sh
# pebbl post-commit: capture the commit into pebbl memory.
HASH=$(git log -1 --pretty=%H)
MESSAGE=$(git log -1 --pretty=%B)
FILES=$(git diff-tree --no-commit-id -r --name-only HEAD | tr '\\n' ',')
# Pin the pebbl that installed this hook so commit-capture runs the INSTALLED
# code's log-commit, not a stale \`pebbl\` first on \$PATH.
PINNED='${pin}'
if [ -n "$PINNED" ] && [ -f "$PINNED" ]; then
  exec node "$PINNED" log-commit "$HASH" "$MESSAGE" "$FILES"
fi
pebbl log-commit "$HASH" "$MESSAGE" "$FILES"
`;
}

// Backward-compatible unpinned template (no installing-bin path baked in). Kept
// for callers/tests that reference HOOK_SCRIPT directly; the INSTALLED hook uses
// the pinned postCommitHook() above.
const HOOK_SCRIPT = postCommitHook('');

// P4 — post-merge / post-checkout rebuild trigger. A `git merge` or
// `git checkout` can pull NEW events.jsonl lines into the store (the whole
// point of committed, shared memory), but the view (view.sqlite + markdown) is
// derived and gitignored, so it would be stale until something rebuilt it.
// These hooks DO NOT fold inline — folding the whole log inside a git hook
// would make every pull/checkout slow and could block on the lock. They only
// TOUCH a sentinel; the actual rebuild is LAZY, done by the staleness check
// (src/staleness.js, wired into openDb) on the very next pebbl command. The
// sentinel is a cheap, idempotent marker that a rebuild is due. mkdir -p guards
// the case where .pebbl/ isn't present in the checked-out tree yet.
const REBUILD_HOOK_SCRIPT = `#!/bin/sh
# pebbl P4: mark the view stale after a merge/checkout pulled new events.
# The rebuild itself is lazy — it happens on the next \`pebbl\` command, never
# here (folding inline would make every pull/checkout slow).
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -d "$ROOT/.pebbl" ] || exit 0
: > "$ROOT/.pebbl/.rebuild-needed" 2>/dev/null || true
exit 0
`;

// P5 — the pre-commit / pre-push secret-scan hooks. The forward gate (design
// Privacy line 41: "scan in git PRE-COMMIT and PRE-PUSH on every commit, not
// one-shot at init"). The hook shells into THIS pebbl's `privacy-scan` and exits
// non-zero on a hit, refusing the commit/push.
//
// Pebbl RESOLUTION is the subtle part. We bake in the ABSOLUTE path of the
// bin/pebbl.js that ran `init` (resolved below), invoked via `node`, so the hook
// always calls the exact pebbl that installed it — independent of $PATH. That
// matters because a DIFFERENT pebbl might be first on $PATH (e.g. a globally
// installed build that predates the `privacy-scan` command); calling it would
// error "unknown command" and wrongly BLOCK every commit. So:
//   1. the pinned `node <installing-bin> privacy-scan` if that bin still exists,
//   2. else a repo-local node_modules/.bin/pebbl,
//   3. else a PATH `pebbl` ONLY IF it understands `privacy-scan` (probed),
//   4. else exit 0 (allow) — a hook that hard-fails on a missing/old binary
//      would block every commit and get deleted; audit-history is the backstop.
// PEBBL_SKIP_SCAN=1 is an explicit operator escape hatch.
function hookScript(mode, pinnedBin) {
  // mode: '--staged' (pre-commit) or '--push' (pre-push).
  const human = mode === '--push'
    ? 'pre-push secret/PII scan + public-repo hard gate. A PUBLIC remote blocks the\n# push until `pebbl audit-history` is clean (clears once clean; re-applies on a\n# once-private remote going public).'
    : 'pre-commit secret/PII scan. Refuses a commit that would write a non-RFC1918\n# IP+port, a credential file path, a token shape, or a denylisted name into\n# shared, append-only memory (which can never un-leak it).';
  // pinnedBin is embedded as a shell-safe single-quoted literal.
  const pin = String(pinnedBin).replace(/'/g, `'\\''`);
  return `#!/bin/sh
# pebbl P5: ${human}
[ -n "$PEBBL_SKIP_SCAN" ] && exit 0
PINNED='${pin}'
if [ -n "$PINNED" ] && [ -f "$PINNED" ]; then
  exec node "$PINNED" privacy-scan ${mode}
fi
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
if [ -x "$ROOT/node_modules/.bin/pebbl" ]; then
  exec "$ROOT/node_modules/.bin/pebbl" privacy-scan ${mode}
fi
# A PATH pebbl is used ONLY if it understands privacy-scan (an older global
# build that doesn't would otherwise hard-block every commit).
if command -v pebbl >/dev/null 2>&1 && pebbl help privacy-scan >/dev/null 2>&1; then
  exec pebbl privacy-scan ${mode}
fi
exit 0
`;
}

// Wire 1 — the public-remote hard gate for `--shared`. Committing events.jsonl
// to a PUBLIC remote is irreversible (append-only memory can never un-leak), so
// --shared on a public remote REFUSES unless the operator BOTH passes
// --allow-public-memory AND the committed .md history is already clean. This
// reuses the SAME machinery the pre-push gate uses (privacy-scan's
// detectRemoteVisibility + fullHistoryMdHits, which wraps audit-history's blob
// walk), so "clean" means exactly the same thing at init, at push, and in
// `pebbl audit-history`. Returns { ok, reason }: ok=false means refuse.
//   - remote NOT positively public (private / unknown / none) -> allow (the repo
//     is the trust boundary, same default as foundation routing). The pre-push
//     gate stays the backstop if a private remote is later flipped public.
//   - public + no --allow-public-memory -> refuse (force an explicit choice).
//   - public + --allow-public-memory + DIRTY history -> refuse (audit first).
//   - public + --allow-public-memory + CLEAN history -> allow.
function checkSharedPublicGate(cwd, allowPublic) {
  const execGit = (a) => {
    try {
      return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  const vis = detectRemoteVisibility(execGit);
  if (vis.visibility !== 'public') {
    return { ok: true, reason: `remote ${vis.visibility} (${vis.reason})` };
  }
  // PUBLIC remote from here down.
  if (!allowPublic) {
    return {
      ok: false,
      reason:
        `the git remote is PUBLIC (${vis.reason}). Committing events.jsonl there is irreversible — ` +
        'shared memory can never be un-leaked. Re-run with --allow-public-memory once you have ' +
        'reviewed `pebbl audit-history` and accept that every entry becomes public.',
    };
  }
  // --allow-public-memory given: still require a CLEAN committed .md history
  // (the same full-history scan the pre-push hard gate runs). Best-effort — a
  // git/tooling failure yields no hits (fail-open here, the pre-push gate is the
  // hard backstop on the actual push).
  const hits = fullHistoryMdHits(cwd);
  if (hits.length > 0) {
    return {
      ok: false,
      reason:
        `the committed .md history is NOT clean (${hits.length} potential leak${hits.length === 1 ? '' : 's'}). ` +
        'Run `pebbl audit-history`, rotate/resolve every finding, then re-run `pebbl init --shared --allow-public-memory`.',
    };
  }
  return { ok: true, reason: 'public remote, --allow-public-memory, audit-history clean' };
}

// Full-history *.md hit list for the gate. Reuses audit-history's blob walk +
// the shared detector (one definition of "clean" — same as the pre-push gate's
// fullHistoryMdHits). Returns hits[]; any tooling failure yields [].
function fullHistoryMdHits(repoRoot) {
  try {
    const { _internal } = require('./audit-history');
    const { scan, loadDenylist } = require('./privacy-scan');
    const pebblDir = path.join(repoRoot, '.pebbl');
    const opts = { repoRoot, pebblDir };
    const pairs = _internal.collectMdBlobs(repoRoot);
    const denylist = loadDenylist(opts);
    const findings = [];
    for (const { commit, path: p } of pairs) {
      const text = _internal.showBlob(repoRoot, commit, p);
      if (!text) continue;
      const hits = scan(text, { ...opts, _denylist: denylist });
      for (const h of hits) findings.push({ ...h, file: p, commit });
    }
    return findings;
  } catch {
    return [];
  }
}

function init(argv) {
  const args = Array.isArray(argv) ? argv : [];
  // Opt-in shared mode. `--shared` relaxes the gitignore to commit events.jsonl;
  // `--allow-public-memory` acknowledges that on a PUBLIC remote that commit is
  // irreversible (see checkSharedPublicGate). Plain `pebbl init` (no flag) keeps
  // the DEFAULT=LOCAL behavior — events.jsonl stays gitignored, byte-for-byte as
  // before. Parsed up front so the public gate can refuse BEFORE any file write.
  const shared = args.includes('--shared');
  const allowPublic = args.includes('--allow-public-memory');

  const cwd = process.cwd();
  const pebblDir = path.join(cwd, '.pebbl');

  // Wire 1 gate: refuse a --shared init on a public remote unless explicitly
  // allowed AND history is clean. Runs before ANY filesystem change so a refused
  // init leaves the tree untouched (no half-created store, no stray gitignore).
  if (shared) {
    const gate = checkSharedPublicGate(cwd, allowPublic);
    if (!gate.ok) {
      console.error(`pebbl init --shared refused: ${gate.reason}`);
      process.exit(1);
    }
  }

  if (fs.existsSync(pebblDir)) {
    console.log('.pebbl/ already exists — skipping directory creation.');
  } else {
    fs.mkdirSync(pebblDir, { recursive: true });
    console.log('Created .pebbl/');
  }

  // Seed empty markdown files
  const manualLogs = path.join(pebblDir, 'manual-logs.md');
  const commitLog  = path.join(pebblDir, 'commit-log.md');
  if (!fs.existsSync(manualLogs)) fs.writeFileSync(manualLogs, '# Manual Logs\n\n');
  if (!fs.existsSync(commitLog))  fs.writeFileSync(commitLog,  '# Commit Log\n\n');

  // Rubric
  const rubricPath = path.join(pebblDir, 'rubric.yml');
  if (!fs.existsSync(rubricPath)) {
    fs.writeFileSync(rubricPath, DEFAULT_RUBRIC);
    console.log('Created rubric.yml');
  }

  // Config
  const configPath = path.join(pebblDir, 'config.yml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, DEFAULT_CONFIG);
    console.log('Created config.yml');
  }

  // Initialize SQLite
  openDb(pebblDir);
  console.log('Initialized db.sqlite');

  // Git hooks
  const gitDir = path.join(cwd, '.git');
  if (fs.existsSync(gitDir)) {
    const hooksDir = path.join(gitDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    // writeFileSync's `mode` only applies on CREATE — an existing hook keeps its
    // old mode — so chmod explicitly after writing to guarantee +x on re-init.
    const writeHook = (name, body) => {
      const p = path.join(hooksDir, name);
      fs.writeFileSync(p, body, { mode: 0o755 });
      fs.chmodSync(p, 0o755);
    };
    // Absolute path of THIS bin/pebbl.js — pinned into the hooks so they run the
    // pebbl that installed them, not whatever `pebbl` is first on $PATH (used by
    // both the post-commit and the P5 pre-commit/pre-push hooks below).
    const pinnedBin = path.resolve(__dirname, '..', 'bin', 'pebbl.js');
    writeHook('post-commit', postCommitHook(pinnedBin));
    console.log('Installed post-commit hook');
    // P4: post-merge + post-checkout mark the view stale (sentinel touch only);
    // the rebuild is lazy on the next pebbl command, never inside the hook.
    writeHook('post-merge', REBUILD_HOOK_SCRIPT);
    writeHook('post-checkout', REBUILD_HOOK_SCRIPT);
    console.log('Installed post-merge and post-checkout rebuild hooks');
    // P5: pre-commit + pre-push secret/PII scanner, installed ADDITIVELY
    // alongside the hooks above (a forward gate runs on every commit/push, not
    // one-shot at init). These do NOT replace the post-* hooks. They reuse the
    // same pinnedBin computed above so they always run the pebbl that installed
    // them, not whatever pebbl happens to be first on $PATH.
    writeHook('pre-commit', hookScript('--staged', pinnedBin));
    writeHook('pre-push', hookScript('--push', pinnedBin));
    console.log('Installed pre-commit and pre-push privacy-scan hooks');
  } else {
    console.log('No .git/ found — skipping git hooks (run inside a git repo to enable).');
  }

  // .gitignore
  // Each line is ADDITIVE and idempotent (ensureIgnoreLine only appends a line
  // that isn't already present, so re-init never duplicates and switching a
  // store LOCAL->shared just adds the negation/disposable lines on top).
  const gitignore = path.join(cwd, '.gitignore');
  const ensureIgnoreLine = (line, label) => {
    if (fs.existsSync(gitignore)) {
      const existing = fs.readFileSync(gitignore, 'utf8');
      if (!existing.split('\n').some((l) => l.trim() === line)) {
        const sep = existing.endsWith('\n') || existing === '' ? '' : '\n';
        fs.appendFileSync(gitignore, `${sep}${line}\n`);
        console.log(`Added ${label} to .gitignore`);
      }
    } else {
      fs.writeFileSync(gitignore, `${line}\n`);
      console.log(`Created .gitignore with ${label}`);
    }
  };

  if (shared) {
    // SHARED store (opt-in via --shared): COMMIT events.jsonl so a teammate /
    // another machine that pulls it sees the merged learnings. Everything else
    // under .pebbl/ stays disposable + machine-private.
    //
    // WHY NOT the blanket `.pebbl/` + a `!.pebbl/events.jsonl` negation: git
    // does NOT descend into a directory excluded by a blanket dir-ignore, so a
    // negation under `.pebbl/` would be inert (events.jsonl would STAY ignored).
    // So shared mode ignores the disposable files EXPLICITLY by name instead of
    // blanket-ignoring the dir, which leaves events.jsonl tracked by default:
    //   - events.local.jsonl : the PRIVATE half of the two-file split — NEVER
    //                          committed, even shared (the fold unions it in
    //                          locally; git only ever carries events.jsonl).
    //   - view.sqlite        : the disposable fold projection (rebuilt on read).
    //                          The FTS5 search index (logs_fts) is an external-
    //                          content virtual table built INSIDE this same file
    //                          (and inside db.sqlite), so it rides this ignore
    //                          line — there is no separate index file to gitignore.
    //   - db.sqlite          : the local canonical index (binary, unmergeable).
    //   - the derived MARKDOWN (manual-logs.md / handoffs.md / commit-log.md /
    //     narrative.md / events-view.md): these are a RENDERING of the fold, not
    //     a source of truth — `view.js rebuildView` regenerates them byte-
    //     identically from events.jsonl on the next read. They are DELIBERATELY
    //     local: committing them would mean two derived artifacts to merge, and
    //     plain markdown has no union driver, so a concurrent edit conflicts (the
    //     reason events.jsonl is the ONLY committed truth). The forward
    //     pre-commit scan still catches a secret because it scans the staged
    //     events.jsonl lines, and audit-history scans committed history; a fresh
    //     shared store commits only events.jsonl, so the source of truth is the
    //     one scanned thing.
    //   - lock / sentinels : concurrency artifacts.
    // Order: the negation `!.pebbl/events.jsonl` re-includes it even if a
    // pre-existing blanket `.pebbl/` line is already in the file (LOCAL->shared
    // upgrade), so it goes LAST.
    ensureIgnoreLine('.pebbl/events.local.jsonl', '.pebbl/events.local.jsonl (private events)');
    ensureIgnoreLine('.pebbl/view.sqlite', '.pebbl/view.sqlite (disposable fold view)');
    ensureIgnoreLine('.pebbl/db.sqlite', '.pebbl/db.sqlite (local index)');
    ensureIgnoreLine('.pebbl/manual-logs.md', '.pebbl/manual-logs.md (derived from the fold)');
    ensureIgnoreLine('.pebbl/handoffs.md', '.pebbl/handoffs.md (derived from the fold)');
    ensureIgnoreLine('.pebbl/commit-log.md', '.pebbl/commit-log.md (derived from the fold)');
    ensureIgnoreLine('.pebbl/narrative.md', '.pebbl/narrative.md (derived from the fold)');
    ensureIgnoreLine('.pebbl/events-view.md', '.pebbl/events-view.md (derived tracer)');
    ensureIgnoreLine('.pebbl/*.lock', '.pebbl/*.lock (local locks)');
    ensureIgnoreLine('.pebbl/.rebuild-needed', '.pebbl/.rebuild-needed (local sentinel)');
    ensureIgnoreLine('!.pebbl/events.jsonl', '.pebbl/events.jsonl (SHARED — committed)');
    // Positive completeness marker: a fresh shared store is 'events' via
    // storeMode step 3 even before its first `pebbl log`. NOT gitignored (shared
    // mode ignores files explicitly by name, never blanket-ignores .pebbl/), so
    // it is committed alongside events.jsonl and pulled by clones. fs.mkdirSync
    // is idempotent; ensure the dir exists before the write (re-init is safe).
    fs.mkdirSync(pebblDir, { recursive: true });
    fs.writeFileSync(
      path.join(pebblDir, EVENTS_CANONICAL_MARKER),
      'events.jsonl is the canonical store (written by pebbl init --shared)\n'
    );
    // Materialize an EMPTY events.jsonl so storeMode()'s step-1 "no events.jsonl"
    // short-circuit does not pre-empt the marker (step 3) on a brand-new shared
    // store that has not been `pebbl log`-ed yet. An empty log folds to an empty
    // view and db.sqlite is empty too, so this is harmless; the first `pebbl log`
    // appends to it as usual. Do NOT clobber a pre-existing log (re-init / a
    // store upgraded LOCAL->shared may already have one).
    const sharedEventsPath = path.join(pebblDir, 'events.jsonl');
    if (!fs.existsSync(sharedEventsPath)) {
      fs.writeFileSync(sharedEventsPath, '');
    }
    console.log('Shared mode: events.jsonl is the COMMITTED source of truth; the SQLite indexes');
    console.log('and the derived markdown stay local (rebuilt from the fold on the next read).');
  } else {
    // DEFAULT = LOCAL (no flag): the whole store is machine-private. Two lines,
    // byte-for-byte the pre-shared-mode behavior:
    //  - `.pebbl/`                   blanket-ignore the store (events.jsonl never
    //                                committed; db.sqlite/view.sqlite disposable).
    //  - `.pebbl/events.local.jsonl` belt-and-suspenders for the private half, so
    //                                the line is present if a store later goes
    //                                --shared and the blanket `.pebbl/` is dropped.
    ensureIgnoreLine('.pebbl/', '.pebbl/');
    ensureIgnoreLine('.pebbl/events.local.jsonl', '.pebbl/events.local.jsonl (private events)');
  }

  // .gitattributes — install the union merge driver for events.jsonl.
  // MANDATORY for clean multi-contributor merge: without `merge=union`,
  // two appends after the same last line conflict. Idempotent: only add
  // the line if it isn't already present (don't duplicate on re-init).
  const gitattributes = path.join(cwd, '.gitattributes');
  const attrLine = '.pebbl/events.jsonl merge=union';
  if (fs.existsSync(gitattributes)) {
    const existing = fs.readFileSync(gitattributes, 'utf8');
    if (!existing.split('\n').some((l) => l.trim() === attrLine)) {
      const sep = existing.endsWith('\n') || existing === '' ? '' : '\n';
      fs.appendFileSync(gitattributes, `${sep}${attrLine}\n`);
      console.log('Added events.jsonl merge=union to .gitattributes');
    }
  } else {
    fs.writeFileSync(gitattributes, `${attrLine}\n`);
    console.log('Created .gitattributes with events.jsonl merge=union');
  }

  // AGENTS.md — create or append, never overwrite user content outside the sentinels
  const agentMd = path.join(cwd, 'AGENTS.md');
  if (!fs.existsSync(agentMd)) {
    fs.writeFileSync(agentMd, AGENT_STANDALONE);
    console.log('Created AGENTS.md with pebbl guidance');
  } else {
    const existing = fs.readFileSync(agentMd, 'utf8');
    const hasNewBlock = existing.includes(AGENT_BEGIN);
    const hasOldBlock = existing.includes('Pebbl — Project Memory Protocol');
    if (!hasNewBlock && !hasOldBlock) {
      fs.appendFileSync(agentMd, AGENT_SECTION);
      console.log('Appended pebbl guidance to existing AGENTS.md');
    } else {
      console.log('AGENTS.md already contains pebbl guidance — run `pebbl upgrade` to refresh');
    }
  }

  // Create empty narrative.md placeholder
  const narrativePath = path.join(pebblDir, 'narrative.md');
  if (!fs.existsSync(narrativePath)) {
    fs.writeFileSync(narrativePath, '# Project Narrative\n');
  }

  console.log('');
  console.log('This project needs a narrative — a short description of what');
  console.log('it does and key architectural context. This helps agents');
  console.log('understand the project without reading all decisions.');
  console.log('');
  console.log('Set one with:  pebbl narrative "Your description here"');

  console.log('\npebbl ready. Run `pebbl log "[your first note]"` to start stacking.');
}

module.exports = init;
module.exports.AGENT_SECTION = AGENT_SECTION;
module.exports.AGENT_BEGIN = AGENT_BEGIN;
module.exports.AGENT_END = AGENT_END;
// Exported so src/upgrade.js installs the SAME pinned post-commit hook (DRY —
// one template, no drift between init and upgrade).
module.exports.postCommitHook = postCommitHook;
module.exports.HOOK_SCRIPT = HOOK_SCRIPT;
