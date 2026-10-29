'use strict';
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb, notCorrected } = require('./db');
const { ensureProjectFiles, loadConfig, loadRubric, atomicityOf, classifyEntryMulti } = require('./rubric');
// REUSE check.js's pure detector for the missing-artifact dimension — do NOT
// reimplement its path/symbol regex here (DRY: one definition of "a cited file
// is gone"). See src/check.js _internal.checkEntries.
const { _internal: checkInternal } = require('./check');
// REUSE search.js's tokenizer for the term-overlap part of the contradiction
// heuristic, so doctor and search agree on what a "term" is (no second
// tokenizer to drift). See src/search.js _internal.normalize.
const { _internal: searchInternal } = require('./search');
// REUSE the handoff well-formedness rule — doctor must agree with create.js on
// what "malformed" means (one definition, no second copy to drift). See
// src/handoff.js malformedSummary.
const { malformedSummary } = require('./handoff');
const { execFileSync } = require('child_process');
const { gitHookHealth } = require('./hooks');

// `pebbl doctor` — a report-only memory-health command. Where `check` compares
// memory-vs-code (does a cited file still exist?), `doctor` compares
// memory-vs-memory: it SURFACES current beliefs that are probably wrong so an
// agent or human can correct them with `pebbl log --corrects <id>`. It NEVER
// judges or edits — every flag is a candidate the caller decides on. Mirrors
// check.js end to end: pure detectors + a thin CLI wrapper + an `_internal`
// export, tier-then-recency sorted, same `if wrong, supersede:` hint line.
//
// REPORT ONLY: this module must never write to or mutate .pebbl/ — no event
// appends, no file writes, no schema/fold changes (the Verify gate enforces it).
// Keeping the LLM out is a hard line too — pebbl stays a single-native-dependency,
// deterministic, offline tool (the LLM-judgment half is a separate factory job
// that consumes --json).

// Tier ordering for the shared sort — same ranking check.js uses, re-exported
// from its _internal so the two commands cannot disagree about tier priority.
const TIER_RANK = checkInternal.TIER_RANK;

// Built-in, conservative defaults. Read overrides from config.doctor.* the way
// compact.js reads config.compaction.* — works with no config at all. `--all`
// widens these at the call site (raises caps, lowers the overlap bar, drops the
// staleness horizon) so the default stays quiet and trustworthy.
const DEFAULTS = {
  // Contradiction: minimum Jaccard overlap of normalized content tokens for two
  // current entries on a shared topic to be flagged as a likely conflict. 0.5
  // is deliberately high so only genuinely similar pairs surface.
  contradiction_overlap: 0.5,
  contradiction_cap: 5,        // top-N pairs, so the section stays short.
  // Staleness: a current component/detail entry older than this many days that
  // nothing newer on its topic reinforces. ~6 months is conservative on
  // purpose — this is the softest, lowest-confidence section.
  staleness_horizon_days: 180,
  staleness_cap: 3,
  // Minimum distinct content tokens an entry must have before it can take part
  // in the overlap math — a one-word entry would trivially match many others.
  min_terms: 3,
  // Handoff staleness: a handoff still status:open this many days after it was
  // written. The friction was 42 "open" handoffs that aren't really open — most
  // were just never closed when their work landed. 14 days is a soft nudge: a
  // handoff open past two weeks is probably finished-but-unclosed, not active.
  handoff_open_days: 14,
  handoff_cap: 10,
  // Non-atomic: top-N multi-topic entries to surface, so the section stays short.
  nonatomic_cap: 10,
};

function loadDoctorConfig(pebblDir, { all = false } = {}) {
  const cfg = (loadConfig(pebblDir) || {}).doctor || {};
  const out = {
    contradictionOverlap: cfg.contradiction_overlap ?? DEFAULTS.contradiction_overlap,
    contradictionCap: cfg.contradiction_cap ?? DEFAULTS.contradiction_cap,
    stalenessHorizonDays: cfg.staleness_horizon_days ?? DEFAULTS.staleness_horizon_days,
    stalenessCap: cfg.staleness_cap ?? DEFAULTS.staleness_cap,
    minTerms: cfg.min_terms ?? DEFAULTS.min_terms,
    handoffOpenDays: cfg.handoff_open_days ?? DEFAULTS.handoff_open_days,
    handoffCap: cfg.handoff_cap ?? DEFAULTS.handoff_cap,
    nonatomicCap: cfg.nonatomic_cap ?? DEFAULTS.nonatomic_cap,
  };
  if (all) {
    // Widen every knob: more output, a lower bar to flag, a shorter horizon.
    out.contradictionOverlap = Math.max(0.3, out.contradictionOverlap - 0.2);
    out.contradictionCap = out.contradictionCap * 4;
    out.stalenessHorizonDays = Math.round(out.stalenessHorizonDays / 2);
    out.stalenessCap = out.stalenessCap * 4;
    // Handoffs: surface every open one (no horizon) and lift the cap.
    out.handoffOpenDays = 0;
    out.handoffCap = out.handoffCap * 10;
    out.nonatomicCap = out.nonatomicCap * 10;
  }
  return out;
}

// ── shared helpers ──────────────────────────────────────────────────────────

// Distinct normalized content tokens of an entry's message, as a Set. Reuses
// search.js normalize() (lowercase, strip non-alphanumerics to spaces) so the
// notion of a "term" is identical to search's. Used for the term-overlap math.
function contentTerms(message) {
  return new Set(searchInternal.normalize(message).split(' ').filter(Boolean));
}

// Topics column is a comma-separated string (see log.js formatEntry). Split it
// into a trimmed, non-empty list — the one place this parse lives in doctor.
function entryTopics(e) {
  return String(e.topics || '').split(',').map(t => t.trim()).filter(Boolean);
}

// Jaccard similarity of two token sets: |A∩B| / |A∪B|. A symmetric 0..1 score
// of how much two messages share, which is what the contradiction heuristic
// thresholds on. Cheap, deterministic, no embeddings.
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function daysBetween(aIso, bIso) {
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.abs(a - b) / 86400000;
}

// ── detector 1: contradictions (new heuristic, memory-vs-memory) ────────────
//
// Candidate = two CURRENT entries that (a) share ≥1 topic, (b) have content
// term-overlap ≥ threshold, and (c) are NOT already linked via corrects /
// relates_to. The OLDER of the pair is marked the likely-superseded one (newer
// belief usually wins), which drives the --corrects hint. Score by overlap,
// then CAP to top-N so the section stays quiet. No LLM: this only says "these
// two look like they're about the same thing and nobody linked them" — the
// caller decides if they actually conflict.
function detectContradictions(entries, { overlap, cap, minTerms } = {}) {
  overlap = overlap ?? DEFAULTS.contradiction_overlap;
  cap = cap ?? DEFAULTS.contradiction_cap;
  minTerms = minTerms ?? DEFAULTS.min_terms;

  // Precompute each entry's term set and topic set once (O(n) not O(n²)).
  const enriched = entries.map(e => ({
    e,
    terms: contentTerms(e.message),
    topics: new Set(entryTopics(e)),
  }));

  // Pairs already linked by the user are NOT contradictions to re-surface — the
  // link IS the resolution. Build a quick lookup of {min-max} id pairs.
  const linked = new Set();
  for (const e of entries) {
    for (const other of [e.corrects, e.relates_to]) {
      if (other != null) linked.add(pairKey(e.id, other));
    }
  }

  const candidates = [];
  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const A = enriched[i], B = enriched[j];
      if (A.terms.size < minTerms || B.terms.size < minTerms) continue;
      if (linked.has(pairKey(A.e.id, B.e.id))) continue;
      // Require a shared topic — the cheap gate that keeps this from comparing
      // every pair of unrelated memories.
      let shareTopic = false;
      for (const t of A.topics) if (B.topics.has(t)) { shareTopic = true; break; }
      if (!shareTopic) continue;

      const score = jaccard(A.terms, B.terms);
      if (score < overlap) continue;

      // Older entry is the likely-superseded one; newer is the survivor.
      const [older, newer] = Date.parse(A.e.timestamp) <= Date.parse(B.e.timestamp)
        ? [A.e, B.e] : [B.e, A.e];
      candidates.push({
        dimension: 'contradiction',
        score,
        older,
        newer,
        sharedTopics: [...A.topics].filter(t => B.topics.has(t)),
      });
    }
  }
  // Highest overlap first, then prefer the pair whose older entry is highest
  // tier (most consequential to get right).
  candidates.sort((a, b) =>
    (b.score - a.score) ||
    ((TIER_RANK[a.older.tier] ?? 9) - (TIER_RANK[b.older.tier] ?? 9)));
  return candidates.slice(0, cap);
}

function pairKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

// ── detector 2: staleness (new heuristic, the quietest section) ─────────────
//
// Candidate = a current component/detail entry older than the horizon that NO
// newer current entry on the same topic reinforces. The idea: an old fact that
// the project never revisited may have quietly drifted out of date. Deliberately
// LOW-CONFIDENCE and capped small — a long-lived foundation truth is SUPPOSED to
// be old, so foundation/fleeting are excluded (foundation is durable by design;
// fleeting is noise). No LLM: it only flags "old and un-reinforced", not "wrong".
function detectStaleness(entries, { horizonDays, cap, now } = {}) {
  horizonDays = horizonDays ?? DEFAULTS.staleness_horizon_days;
  cap = cap ?? DEFAULTS.staleness_cap;
  const nowMs = now != null ? Date.parse(now) : Date.now();

  // For each topic, the timestamp of the NEWEST current entry touching it.
  const newestByTopic = new Map();
  for (const e of entries) {
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts)) continue;
    for (const t of entryTopics(e)) {
      const prev = newestByTopic.get(t);
      if (prev == null || ts > prev) newestByTopic.set(t, ts);
    }
  }

  const candidates = [];
  for (const e of entries) {
    if (e.tier !== 'component' && e.tier !== 'detail') continue;
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts)) continue;
    const ageDays = (nowMs - ts) / 86400000;
    if (ageDays < horizonDays) continue;

    const topics = entryTopics(e);
    // Un-reinforced = no NEWER current entry shares any of its topics. (An entry
    // is the newest on its own topic when newestByTopic === its own ts.)
    const reinforced = topics.some(t => (newestByTopic.get(t) ?? -Infinity) > ts);
    if (reinforced) continue;
    // An entry with no topics can't be reinforced-by-topic, but it's also too
    // weak a signal to flag — skip it to keep this section quiet.
    if (topics.length === 0) continue;

    candidates.push({ dimension: 'staleness', entry: e, ageDays: Math.round(ageDays) });
  }
  // Oldest (highest age) first — the stalest are the most worth a look.
  candidates.sort((a, b) => b.ageDays - a.ageDays);
  return candidates.slice(0, cap);
}

// ── detector 3: missing artifact (REUSE check.js, no new regex) ─────────────
//
// Delegates entirely to check.js's pure checkEntries — doctor adds nothing here
// but the dimension wrapper, so there is no duplicated path/symbol regex (a
// hard Acceptance line). `deep` passes straight through, same meaning as
// `check --deep`.
function detectMissing(entries, repoRoot, { deep = false } = {}) {
  const flagged = checkInternal.checkEntries(entries, repoRoot, { deep });
  return flagged.map(e => ({ dimension: 'missing', entry: e }));
}

// ── detector 4: handoff health (lifecycle, the friction this task targets) ───
//
// Two memory-vs-memory signals over the handoffs table (NOT the logs table):
//   - MALFORMED: an open handoff whose summary fails malformedSummary() — a
//     bare number / stub / stray subcommand word that never described real work
//     (the ~10 junk handoffs that polluted the open count). Reuses the SAME rule
//     create.js now rejects, so a stub written before the guard still surfaces.
//   - LONG-OPEN: a handoff still status:open past handoffOpenDays — almost
//     certainly finished-but-never-closed (the close-on-completion gap). Pure +
//     report-only: it never closes anything, it just makes the rot visible so a
//     human/agent can `pebbl handoff --close <id>`.
// Takes already-loaded handoff rows so it stays side-effect-free and testable.
function detectHandoffHealth(handoffs, { openDays, cap, now } = {}) {
  openDays = openDays ?? DEFAULTS.handoff_open_days;
  cap = cap ?? DEFAULTS.handoff_cap;
  const nowMs = now != null ? Date.parse(now) : Date.now();

  const out = [];
  for (const h of handoffs) {
    if (String(h.status || 'open') !== 'open') continue; // only open ones can rot
    const malformed = malformedSummary(h.summary);
    const ts = Date.parse(h.timestamp);
    const ageDays = Number.isNaN(ts) ? 0 : (nowMs - ts) / 86400000;
    const longOpen = ageDays >= openDays;
    if (!malformed && !longOpen) continue;
    out.push({
      dimension: 'handoff',
      handoff: h,
      malformed: malformed || null,         // reason string, or null
      ageDays: Math.round(ageDays),
      longOpen,
    });
  }
  // Malformed first (highest-confidence junk), then oldest-open. Cap to stay quiet.
  out.sort((a, b) =>
    (Number(!!b.malformed) - Number(!!a.malformed)) || (b.ageDays - a.ageDays));
  return out.slice(0, cap);
}

// ── detector 5: non-atomic entries (multi-topic, report-only) ────────────────
//
// An atomic memory is one fact per row. When a single `pebbl log` crams several
// facts together ("chose X, refactored module Y, and the schema changed"), the
// rubric still files it under ONE category — picked by rule order — so the other
// facts hide under a label that doesn't describe them. This detector RE-READS
// each current entry with the order-independent classifyEntryMulti and flags the
// rows whose message trips multiple distinct categories. It NEVER splits, edits,
// or re-files anything: it only surfaces "this looks like several facts in one
// row" so a human/agent can re-log them one fact at a time.
//
// Heuristic — an entry qualifies when it matches:
//   - >= 3 distinct categories (strong signal on its own), OR
//   - >= 2 distinct categories AND message length > 300 chars (a long entry
//     straddling two topics is probably two entries).
// The threshold itself lives in rubric.atomicityOf — the ONE shared predicate
// `pebbl log --strict` also enforces, so detect and enforce can't drift (DRY).
// atomicityOf additionally scopes OUT session/fleeting/uncategorized entries
// (they aren't memory facts), which fixes the old false positive on fat session
// logs. `rules` defaults to [] so older callers that omit it (and the pure
// tests) simply get an empty result.
function detectNonAtomic(entries, rules, { cap } = {}) {
  cap = cap ?? DEFAULTS.nonatomic_cap;
  rules = rules || [];

  const out = [];
  for (const e of entries) {
    const a = atomicityOf(rules, e.message);
    if (!a.nonAtomic) continue;
    out.push({ dimension: 'nonatomic', entry: e, categories: a.categories });
  }
  // Most tangled first (most categories), then longest message. Cap to stay quiet.
  out.sort((a, b) =>
    (b.categories.length - a.categories.length) ||
    (String(b.entry.message || '').length - String(a.entry.message || '').length));
  return out.slice(0, cap);
}

// ── compose all five (pure) ─────────────────────────────────────────────────
//
// Pure orchestrator over already-loaded current-belief entries: returns the
// five detector result arrays. Kept side-effect-free so tests drive it without
// a real store (the check.js _internal pattern). `handoffs` is optional — when
// absent (older callers / no handoffs table), the handoff section is empty.
// `rules` is optional too — without it the non-atomic section is empty.
function diagnose(entries, repoRoot, opts = {}) {
  return {
    contradictions: detectContradictions(entries, {
      overlap: opts.contradictionOverlap,
      cap: opts.contradictionCap,
      minTerms: opts.minTerms,
    }),
    staleness: detectStaleness(entries, {
      horizonDays: opts.stalenessHorizonDays,
      cap: opts.stalenessCap,
      now: opts.now,
    }),
    missing: detectMissing(entries, repoRoot, { deep: !!opts.deep }),
    handoffs: detectHandoffHealth(opts.handoffs || [], {
      openDays: opts.handoffOpenDays,
      cap: opts.handoffCap,
      now: opts.now,
    }),
    nonatomic: detectNonAtomic(entries, opts.rules, {
      cap: opts.nonatomicCap,
    }),
  };
}

// ── atomicity SCOREBOARD (quantitative metric, for tracking + A/B) ───────────
//
// Where detectNonAtomic LISTS the worst multi-topic offenders (capped, for a
// human to act on), this computes the QUANTITATIVE rate over ALL current
// entries — a scriptable number we can track over time and A/B against a
// "one-fact-per-log" convention. Pure: takes already-loaded entries + the
// rubric rules, returns the scoreboard object. REUSES atomicityOf and
// classifyEntryMulti (the ONE shared scorer) — there is NO second definition of
// "non-atomic" or "how many categories" here (DRY).
//
// Definitions (all over the `total` current, notCorrected entries doctor loads):
//   - total:             number of entries measured.
//   - nonAtomic:         { count, rate } where count = entries atomicityOf flags
//                        non-atomic, rate = count/total as a percent (1 decimal).
//                        This is the headline "multi-topic rate".
//   - meanCategories:    mean distinct categories matched per entry (1 decimal);
//                        an entry that matches no rule counts as 0.
//   - distribution:      how many entries match 0 / 1 / 2 / 3+ distinct
//                        categories (categories.length from classifyEntryMulti).
//   - uncategorizedRate: percent (1 decimal) of entries whose classifyEntryMulti
//                        primary is `uncategorized` OR that match no rule at all
//                        (categories.length === 0). This is the A/B GUARD: a
//                        "fix" that lowers the non-atomic rate only by making
//                        entries match nothing (so they file under no real fact
//                        category) makes THIS balloon, so the regression shows.
function atomicityMetrics(entries, rules) {
  rules = rules || [];
  const total = entries.length;
  let nonAtomic = 0;
  let uncategorized = 0;
  let categorySum = 0;
  const distribution = { '0': 0, '1': 0, '2': 0, '3plus': 0 };

  for (const e of entries) {
    const msg = e.message;
    const m = classifyEntryMulti(rules, msg);          // null when no rule matched
    const n = m ? m.categories.length : 0;
    categorySum += n;
    distribution[n === 0 ? '0' : n === 1 ? '1' : n === 2 ? '2' : '3plus']++;
    // "Uncategorized" for the guard = filed under no real fact category: either
    // the primary is the `uncategorized` bucket (session/heartbeat logs) or the
    // message tripped no rule at all (m === null).
    if (!m || m.category === 'uncategorized') uncategorized++;
    // REUSE the shared predicate — do not re-derive the non-atomic threshold.
    if (atomicityOf(rules, msg).nonAtomic) nonAtomic++;
  }

  const pct = (x) => total === 0 ? 0 : Math.round((x / total) * 1000) / 10;
  const meanCategories = total === 0 ? 0 : Math.round((categorySum / total) * 10) / 10;

  return {
    total,
    nonAtomic: { count: nonAtomic, rate: pct(nonAtomic) },
    meanCategories,
    distribution,
    uncategorizedRate: pct(uncategorized),
  };
}

// Compact human block for `pebbl doctor --metrics` (no --json). A few labeled
// lines, not a wall. toFixed(1) so a whole-number rate still reads "46.0".
function printMetrics(m) {
  const d = m.distribution;
  console.log(`\npebbl doctor — atomicity scoreboard (${m.total} current ${m.total === 1 ? 'entry' : 'entries'}):`);
  console.log(`  non-atomic:       ${m.nonAtomic.count} / ${m.total}  (${m.nonAtomic.rate.toFixed(1)}%)  — multi-fact entries`);
  console.log(`  mean categories:  ${m.meanCategories.toFixed(1)} per entry`);
  console.log(`  distribution:     0→${d['0']}  1→${d['1']}  2→${d['2']}  3+→${d['3plus']}  (categories matched per entry)`);
  console.log(`  uncategorized:    ${m.uncategorizedRate.toFixed(1)}%  — A/B guard (entries filed under no real category)`);
}

// ── JSON shaping for the future factory caller ──────────────────────────────
//
// Flatten the three detector outputs into a single array of uniform candidate
// objects { dimension, ids, reason, suggested } — the contract the scheduling +
// LLM-judgment follow-up consumes. `suggested` is the exact `pebbl log` command
// to run if the caller decides the entry is wrong.
// ── install health (the store vs the repo it lives in) ──────────────────────
// Separate from diagnose(): these read git and the hooks dir, not memory.

const HOOK_ADVICE = {
  missing: 'not installed',
  foreign: 'is another tool\'s hook, not pebbl\'s',
  'not-executable': 'is not executable',
  'pinned-bin-missing': 'pins a pebbl that no longer exists',
};

// pebbl hooks that aren't working. Empty outside a git repo.
function detectHookProblems(repoRoot) {
  const health = gitHookHealth(repoRoot);
  if (!health) return [];
  return health.filter((h) => h.status !== 'ok');
}

// Commits on HEAD made since the store started capturing that the commits
// table doesn't hold. Matched on hash OR subject line: a rebase (Mobile-Home-
// Parks pulls with --rebase) rewrites every hash but keeps the message. Merge
// commits and GitHub-made commits are skipped — no local post-commit ever runs
// for those. Returns { count, examples, since } or null when there is nothing
// to compare (no git, no captures yet).
function detectUncapturedCommits(db, repoRoot, { cap = 5 } = {}) {
  let captured;
  try {
    captured = db.prepare('SELECT timestamp, hash, message FROM commits ORDER BY timestamp ASC').all();
  } catch {
    return null;
  }
  if (captured.length === 0) return null;
  const since = captured[0].timestamp;
  let log;
  try {
    log = execFileSync('git', ['log', '--no-merges', `--since=${since}`, '--format=%H%x00%ce%x00%s'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const hashes = new Set(captured.map((c) => c.hash));
  const subjects = new Set(captured.map((c) => String(c.message || '').split('\n')[0].trim()));
  const missing = [];
  for (const line of log.split('\n')) {
    if (!line) continue;
    const [hash, committer, subject] = line.split('\0');
    if (committer === 'noreply@github.com') continue;
    if (hashes.has(hash) || subjects.has(String(subject).trim())) continue;
    missing.push({ hash, subject });
  }
  return { count: missing.length, examples: missing.slice(0, cap), since };
}

function installFindingCount(install) {
  if (!install) return 0;
  return install.hooks.length + (install.uncaptured && install.uncaptured.count ? 1 : 0);
}

function toJson(results) {
  const out = [];
  for (const c of results.contradictions) {
    out.push({
      dimension: 'contradiction',
      ids: [c.older.id, c.newer.id],
      reason: `current entries share topic(s) ${c.sharedTopics.join(', ')} with ${(c.score * 100) | 0}% term overlap and are not linked; older #${c.older.id} may be superseded by #${c.newer.id}`,
      suggested: supersedeHint(c.older.id),
    });
  }
  for (const c of results.staleness) {
    out.push({
      dimension: 'staleness',
      ids: [c.entry.id],
      reason: `low-confidence: ${c.ageDays}d old and not reinforced by any newer entry on its topic(s)`,
      suggested: supersedeHint(c.entry.id),
    });
  }
  for (const c of results.missing) {
    const e = c.entry;
    const bits = [];
    if (e.missingPaths && e.missingPaths.length) bits.push(`missing path ${e.missingPaths.join(', ')}`);
    if (e.missingSymbols && e.missingSymbols.length) bits.push(`missing symbol ${e.missingSymbols.join(', ')}`);
    out.push({
      dimension: 'missing',
      ids: [e.id],
      reason: bits.join('; '),
      suggested: supersedeHint(e.id),
    });
  }
  for (const c of results.handoffs || []) {
    const h = c.handoff;
    const reason = c.malformed
      ? `handoff #${h.id} summary is malformed (${c.malformed}) and still open`
      : `handoff #${h.id} has been open ${c.ageDays}d — likely finished but never closed`;
    out.push({
      dimension: 'handoff',
      ids: [h.id],
      reason,
      suggested: closeHint(h.id),
    });
  }
  for (const c of results.nonatomic || []) {
    out.push({
      dimension: 'nonatomic',
      ids: [c.entry.id],
      reason: `matches ${c.categories.length} categories (${c.categories.join(', ')}) — likely several facts in one entry`,
      suggested: splitHint(c.entry.id),
    });
  }
  const install = results.install;
  for (const h of (install && install.hooks) || []) {
    out.push({
      dimension: 'hook',
      ids: [],
      reason: `git ${h.name} hook ${HOOK_ADVICE[h.status] || h.status}`,
      suggested: 'pebbl upgrade',
    });
  }
  if (install && install.uncaptured && install.uncaptured.count) {
    const u = install.uncaptured;
    out.push({
      dimension: 'capture',
      ids: [],
      reason: `${u.count} commit${u.count === 1 ? '' : 's'} since ${u.since.slice(0, 10)} never captured (e.g. ${u.examples.map((e) => e.hash.slice(0, 7)).join(', ')})`,
      suggested: 'pebbl upgrade (reinstalls the post-commit hook); pebbl scan-commits to log decisions they held',
    });
  }
  return out;
}

function supersedeHint(id) {
  return `pebbl log "<corrected memory>" --corrects ${id}`;
}

// Handoffs don't supersede — they close. The fix for a malformed or finished-
// but-open handoff is to close it (report-only doctor never does this itself).
function closeHint(id) {
  return `pebbl handoff --close ${id}`;
}

// Non-atomic entries aren't superseded or closed — they're split. There's no
// single command to run (the caller decides how many facts to peel off), so the
// hint is a template re-log, one fact per entry. Report-only doctor never splits.
function splitHint(id) {
  return `pebbl log "<one fact>"  # split #${id} into atomic entries (one fact per pebbl log)`;
}

function truncate(msg) {
  return msg.length > 100 ? msg.slice(0, 100) + '…' : msg;
}

function fmtEntry(e) {
  const date = String(e.timestamp || '').slice(0, 10);
  return `#${e.id} [${e.tier}|${e.category}] ${date} — ${truncate(e.message)}`;
}

// ── CLI wrapper (thin, the check.js shape) ──────────────────────────────────

module.exports = function doctor(args) {
  const { flags } = parseArgs(args);
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  const repoRoot = path.dirname(path.resolve(pebblDir));
  const opts = loadDoctorConfig(pebblDir, { all: !!flags.all });
  opts.deep = !!flags.deep;
  // Rubric rules for the non-atomic detector. Loaded the same way log/scan do
  // (ensureProjectFiles above already created/migrated rubric.yml). Empty when a
  // store has no rubric — the non-atomic section then simply finds nothing.
  opts.rules = loadRubric(pebblDir);

  // openDb already calls staleness.ensureFresh(pebblDir) on the read path (see
  // db.js openDb), so a just-pulled events.jsonl is materialized before we read.
  const db = openDb(pebblDir);
  // CURRENT BELIEFS ONLY: notCorrected() is valid_to IS NULL (the one definition
  // of "current", db.js), and tier != 'archived' drops compacted history. This
  // is the same current-belief filter context.js uses.
  const entries = db.prepare(
    `SELECT id, timestamp, category, tier, message, topics, relates_to, corrects
       FROM logs
      WHERE tier != 'archived' AND ${notCorrected()}
      ORDER BY timestamp DESC`
  ).all();

  // --metrics: SHORT-CIRCUIT the 4-detector report and print ONLY the
  // quantitative atomicity scoreboard, computed over the SAME current entries
  // above. Placed before the handoffs query + diagnose so no detector runs (the
  // hard short-circuit the test asserts). --json emits the machine-readable
  // scoreboard for scripting the A/B.
  if (flags.metrics) {
    const metrics = atomicityMetrics(entries, opts.rules);
    if (flags.json) {
      console.log(JSON.stringify(metrics, null, 2));
    } else {
      printMetrics(metrics);
    }
    return;
  }

  // Open handoffs for the lifecycle/health detector. Read-only SELECT (doctor
  // never mutates the store). Guarded in case an older store has no handoffs
  // table — fall back to an empty list so doctor still runs.
  let handoffs = [];
  try {
    handoffs = db.prepare(
      `SELECT id, timestamp, summary, status FROM handoffs WHERE status = 'open' ORDER BY id DESC`
    ).all();
  } catch {
    handoffs = []; // no handoffs table (pre-handoff store)
  }
  opts.handoffs = handoffs;

  const results = diagnose(entries, repoRoot, opts);
  results.install = {
    hooks: detectHookProblems(repoRoot),
    uncaptured: detectUncapturedCommits(db, repoRoot),
  };

  if (flags.json) {
    console.log(JSON.stringify(toJson(results), null, 2));
    return;
  }

  const total = results.contradictions.length + results.staleness.length
    + results.missing.length + results.handoffs.length + results.nonatomic.length
    + installFindingCount(results.install);
  if (total === 0) {
    console.log('pebbl doctor: memory looks consistent — no contradictions, stale beliefs, missing artifacts, stale/malformed handoffs, or non-atomic entries flagged.');
    return;
  }

  console.log(`\npebbl doctor — ${total} candidate${total === 1 ? '' : 's'} to review (report only, nothing changed):`);

  if (results.contradictions.length) {
    console.log(`\nContradictions — current entries that look like they conflict and aren't linked:\n`);
    for (const c of results.contradictions) {
      console.log(fmtEntry(c.older));
      console.log(fmtEntry(c.newer));
      console.log(`   reason: share topic(s) ${c.sharedTopics.join(', ')}, ${(c.score * 100) | 0}% term overlap; older #${c.older.id} may be superseded by newer #${c.newer.id}`);
      console.log(`   if wrong, supersede:  ${supersedeHint(c.older.id)}`);
      console.log();
    }
  }

  if (results.missing.length) {
    const n = results.missing.length;
    console.log(`\nMissing artifact — ${n} ${n === 1 ? 'entry cites a' : 'entries cite'} file/symbol that no longer exists:\n`);
    for (const c of results.missing) {
      const e = c.entry;
      console.log(fmtEntry(e));
      if (e.missingPaths && e.missingPaths.length) console.log(`   missing path: ${e.missingPaths.join(', ')}`);
      if (e.missingSymbols && e.missingSymbols.length) console.log(`   missing symbol: ${e.missingSymbols.join(', ')}`);
      console.log(`   if wrong, supersede:  ${supersedeHint(e.id)}`);
      console.log();
    }
  }

  if (results.staleness.length) {
    console.log(`\nStaleness (low confidence) — old beliefs nothing newer reinforces; may be fine:\n`);
    for (const c of results.staleness) {
      console.log(fmtEntry(c.entry));
      console.log(`   reason: ${c.ageDays}d old, not reinforced by any newer entry on its topic(s)`);
      console.log(`   if wrong, supersede:  ${supersedeHint(c.entry.id)}`);
      console.log();
    }
  }

  if (results.handoffs.length) {
    const n = results.handoffs.length;
    console.log(`\nHandoffs — ${n} open handoff${n === 1 ? '' : 's'} that look stale or malformed (the open count is only meaningful if these get closed):\n`);
    for (const c of results.handoffs) {
      const h = c.handoff;
      const date = String(h.timestamp || '').slice(0, 10);
      console.log(`#${h.id} [open] ${date} — ${truncate(String(h.summary || ''))}`);
      if (c.malformed) {
        console.log(`   reason: malformed summary (${c.malformed}) — never described real work`);
      } else {
        console.log(`   reason: open ${c.ageDays}d — likely finished but never closed`);
      }
      console.log(`   if done, close:  ${closeHint(h.id)}`);
      console.log();
    }
  }

  const install = results.install;
  if (installFindingCount(install)) {
    console.log(`\nInstall — the hooks that feed memory:\n`);
    for (const h of install.hooks) {
      console.log(`git ${h.name} hook ${HOOK_ADVICE[h.status] || h.status}${h.pinned ? ` (${h.pinned})` : ''}`);
    }
    if (install.hooks.length) console.log(`   fix:  pebbl upgrade`);
    const u = install.uncaptured;
    if (u && u.count) {
      console.log(`${u.count} commit${u.count === 1 ? '' : 's'} since ${u.since.slice(0, 10)} never captured, e.g.:`);
      for (const e of u.examples) console.log(`   ${e.hash.slice(0, 7)} ${truncate(String(e.subject || ''))}`);
      console.log(`   reason: post-commit hook missing when they were made, or made on another machine`);
      console.log(`   fix:  pebbl upgrade; pebbl scan-commits suggests entries for decisions they held`);
    }
    console.log();
  }

  if (results.nonatomic.length) {
    const n = results.nonatomic.length;
    console.log(`\nNon-atomic entries — ${n} ${n === 1 ? 'entry looks' : 'entries look'} like several facts crammed into one row:\n`);
    for (const c of results.nonatomic) {
      console.log(fmtEntry(c.entry));
      console.log(`   reason: matches ${c.categories.length} categories (${c.categories.join(', ')}) — probably more than one fact`);
      console.log(`   if so, consider splitting into atomic entries (one fact per \`pebbl log\`)`);
      console.log();
    }
  }
};

module.exports._internal = {
  detectContradictions,
  detectStaleness,
  detectMissing,
  detectHandoffHealth,
  detectNonAtomic,
  detectHookProblems,
  detectUncapturedCommits,
  atomicityMetrics,
  diagnose,
  toJson,
  contentTerms,
  entryTopics,
  jaccard,
  pairKey,
  daysBetween,
  loadDoctorConfig,
  DEFAULTS,
  TIER_RANK,
};
