'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { openDb } = require('./db');
const { DEFAULT_RUBRIC, DEFAULT_CONFIG, loadConfig, handoffSettings } = require('./rubric');
const hooks = require('./hooks');
const { installGitHooks, installClaudeStopHook, ensureClaudeImport } = hooks;
const { readNarrative, writeNarrative } = require('./narrative');
const { detectRemoteVisibility } = require('./privacy-scan');
// DRY: the positive completeness marker name is owned by store-mode.js (its
// reader); shared init writes it so storeMode() classifies a fresh shared store
// as 'events' without depending on a per-read git spawn.
const { EVENTS_CANONICAL_MARKER } = require('./store-mode');

const AGENT_BEGIN = '<!-- pebbl:begin -->';
const AGENT_END = '<!-- pebbl:end -->';

// The AGENTS.md block is RENDERED from .pebbl/config.yml (`handoff.docs`,
// `handoff.docs_dir`) so it says what this repo actually wants. Before, the
// block was one fixed text and a repo with a different handoff style had to
// override it in CLAUDE.md (Mobile-Home-Parks: "This overrides the
// detail-heavy handoff paragraph in AGENTS.md").
function docsParagraph({ docs, docsDir }) {
  if (docs === 'never') {
    return 'Keep handoff items to one line each that point at where the detail lives. Don\'t write a handoff doc unless the owner asks for one.';
  }
  if (docs === 'always') {
    return `Write the session's detail to a doc in \`${docsDir}/\` and link it with \`--docs <path>\`. pebbl refuses a handoff without \`--docs\` (or an explicit \`--no-doc\`).`;
  }
  return `If the detail runs long, write it to a doc in \`${docsDir}/\` and link it with \`--docs <path>\`; the fields stay one-liners. pebbl refuses a long handoff that has neither \`--docs\` nor \`--no-doc\`.`;
}

function renderAgentSection(config) {
  return `
${AGENT_BEGIN}
## Pebbl — Memory

pebbl is this project's memory: an index of decisions, dead ends and handoffs, not a place for documents. Flags: \`pebbl <cmd> --help\`. Concepts: \`pebbl help <topic>\` (categories, tiers, compaction).

**Start of every session:** run \`pebbl context\`. An open handoff's \`done\` is what the previous session finished, not you; its \`todo\` is what's left.

**Before a non-trivial choice:** \`pebbl search "<area>"\`, so you don't re-litigate a settled decision.

**Log the moment a choice is made or an approach fails**, one line: what, why, and where the detail lives (a doc, a file, a PR). Always pass \`--cat\` and \`--topic\`.

\`\`\`bash
pebbl log "nightly import moved to 2am because the 1am run overlapped backups (see docs/ops.md)" --cat decision --topic import
\`\`\`

\`--cat\`: \`decision\` a choice and why · \`steering\` a dead end, what to do instead · \`pattern\` a convention · \`structure\` where things live · \`integration\` an outside system · \`quality\` a target or measurement.

**End of every session:** \`pebbl handoff "<one line>" --done "a; b" --todo "c; d" --topic <area>\`. One item per \`;\`, or repeat \`--done\` / \`--todo\` once per item. A new handoff closes the previous one: put its finished items in \`--done\` and open ones in \`--todo\`; any of its todos you list in neither carry over. Pass \`--keep-open\` only if another session is still working on it.

${docsParagraph(handoffSettings(config))}

If a Stop hook holds your turn for unlogged changes, log what's missing, or say nothing this turn was worth keeping.

**Don't log** routine code changes (the commit hook captures commits) or anything obvious from reading the code.
${AGENT_END}
`;
}

// Default-config rendering, kept as a constant for callers that predate the
// renderer (and for a store with no config.yml).
const AGENT_SECTION = renderAgentSection({});

function agentStandalone(config) {
  return `# Agent Guidelines\n${renderAgentSection(config)}`;
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

  // Git hooks (all five, pinned to this pebbl + node — src/hooks.js).
  if (!installGitHooks(cwd)) {
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
    // The anon map holds REAL names by definition — the one store file that must
    // never be committed. It needs stating HERE because shared mode ignores files
    // by name rather than blanket-ignoring `.pebbl/`, so nothing else covers it.
    ensureIgnoreLine('.pebbl/name-map.json', '.pebbl/name-map.json (PII map — never committed)');
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
    // NOT name-map.json here: the blanket `.pebbl/` above already covers it, and
    // the default gitignore is pinned byte-for-byte by test. A store that later
    // switches to --shared picks up the explicit line then, which is the only
    // mode where the blanket is gone and the guarantee needs stating.
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
    fs.writeFileSync(agentMd, agentStandalone(loadConfig(pebblDir)));
    console.log('Created AGENTS.md with pebbl guidance');
  } else {
    const existing = fs.readFileSync(agentMd, 'utf8');
    const hasNewBlock = existing.includes(AGENT_BEGIN);
    const hasOldBlock = existing.includes('Pebbl — Project Memory Protocol');
    if (!hasNewBlock && !hasOldBlock) {
      fs.appendFileSync(agentMd, renderAgentSection(loadConfig(pebblDir)));
      console.log('Appended pebbl guidance to existing AGENTS.md');
    } else {
      console.log('AGENTS.md already contains pebbl guidance — run `pebbl upgrade` to refresh');
    }
  }

  // Claude Code reads CLAUDE.md, not AGENTS.md: import it when a CLAUDE.md exists.
  ensureClaudeImport(cwd);

  // Stop hook: holds a turn that changed files without logging (check-session).
  if (!args.includes('--no-claude-hooks')) {
    installClaudeStopHook(cwd);
  }

  // Narrative. An empty placeholder is what most stores were left with (the
  // printed "set one with" hint was easy to skip), so seed it from README's
  // first paragraph when there is one and say so; the agent corrects it later.
  const narrativePath = path.join(pebblDir, 'narrative.md');
  if (!fs.existsSync(narrativePath)) {
    fs.writeFileSync(narrativePath, '# Project Narrative\n');
  }
  console.log('');
  const seeded = seedNarrative(pebblDir, cwd);
  if (seeded === null) {
    console.log('Narrative already set (pebbl narrative to change it).');
  } else if (!seeded) {
    console.log('This project needs a narrative — a short description of what');
    console.log('it does and key architectural context. This helps agents');
    console.log('understand the project without reading all decisions.');
    console.log('');
    console.log('Set one with:  pebbl narrative "Your description here"');
  }

  console.log('\npebbl ready. Run `pebbl log "[your first note]"` to start stacking.');
}

// Seed an EMPTY narrative from README. Returns null when one is already set,
// the seeded text when it wrote one, '' when README had nothing usable. Used by
// init and by upgrade (existing stores were mostly left with the placeholder).
function seedNarrative(pebblDir, cwd, log = console.log) {
  if (readNarrative(pebblDir)) return null;
  const seeded = readmeNarrative(cwd);
  if (!seeded) return '';
  writeNarrative(pebblDir, seeded, []);
  log('Seeded the narrative from README.md:');
  log(`  ${seeded}`);
  log('Correct it with:  pebbl narrative "Your description here"');
  return seeded;
}

// First prose paragraph of the project README, flattened to one line, or null.
// Skips headings, badges, HTML and code fences; strips link/emphasis markup.
const NARRATIVE_SEED_MAX = 600;
function readmeNarrative(cwd) {
  const file = ['README.md', 'README', 'readme.md'].map((f) => path.join(cwd, f)).find((f) => fs.existsSync(f));
  if (!file) return null;
  const para = [];
  let inFence = false;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) { inFence = !inFence; if (para.length) break; continue; }
    if (inFence) continue;
    const skip = line === '' || /^(#|!\[|\[!\[|<|>|---|\||- |\* |\d+\. )/.test(line);
    if (skip) {
      if (para.length) break;
      continue;
    }
    para.push(line);
  }
  if (para.length === 0) return null;
  let text = para.join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 20) return null;
  if (text.length > NARRATIVE_SEED_MAX) text = text.slice(0, NARRATIVE_SEED_MAX).replace(/\s+\S*$/, '') + '…';
  return text;
}

module.exports = init;
module.exports.AGENT_SECTION = AGENT_SECTION;
module.exports.renderAgentSection = renderAgentSection;
module.exports.handoffSettings = handoffSettings;
module.exports.readmeNarrative = readmeNarrative;
module.exports.seedNarrative = seedNarrative;
module.exports.AGENT_BEGIN = AGENT_BEGIN;
module.exports.AGENT_END = AGENT_END;
// Exported so src/upgrade.js installs the SAME pinned post-commit hook (DRY —
// one template, no drift between init and upgrade).
module.exports.postCommitHook = hooks.postCommitHook;
module.exports.HOOK_SCRIPT = hooks.postCommitHook('', '');
