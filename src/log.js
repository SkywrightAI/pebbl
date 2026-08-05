'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs, assertCompleteFlags, assertIntegerFlags, assertEntryRefFlags } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { loadRubric, classifyEntryMulti, atomicityOf, ensureProjectFiles } = require('./rubric');
const { isThinEntry } = require('./detect-thin');
const { execFileSync } = require('child_process');
const { appendLogEvent, appendCorrectLogEvent, appendReassertEvent } = require('./events');
const { detectRemoteVisibility, redact } = require('./privacy-scan');
const { guardWrite } = require('./secret-guard');
const { guardNames } = require('./name-guard');
const { importanceForTier } = require('./rank');

// P5 — foundation private-by-default (design Q3=B). Decide whether THIS entry's
// event goes to the PRIVATE events.local.jsonl (machine-only) or the SHARED
// events.jsonl (git-transported). Pure + testable: the visibility string is
// passed in. Rule:
//   - Only FOUNDATION-tier entries are ever private-by-default.
//   - That default applies ONLY on a PUBLIC remote (Q3=B — a private repo is
//     already the trust boundary, so foundation shares freely there).
//   - `--share` overrides the default and forces the SHARED file even on public.
// So: route local  <=>  tier === 'foundation' && visibility === 'public' && !share.
// On 'private' or 'unknown' visibility, foundation shares freely (returns false).
function shouldRouteLocal({ tier, share, visibility }) {
  if (tier !== 'foundation') return false;     // only foundation is private-by-default
  if (share) return false;                     // explicit opt-in to shared
  return visibility === 'public';              // private-by-default on public only
}

const VALID_CATEGORIES = [
  'decision', 'structure', 'pattern', 'data', 'integration', 'quality',
  'steering',
];

// Deprecated category aliases: old name -> canonical. `correction` was renamed
// to `steering` (course-correction/guidance reads broader and more intuitive
// than "correction", which sounds error-only; the category now also catches
// "friction" entries). We accept the old name on INPUT and normalize it to the
// canonical value BEFORE validation/storage, so muscle memory and old scripts
// keep working. Already-stored rows keep their original "correction" value — the
// rename is forward-only; read paths treat the two as one (see readback.js).
const CATEGORY_ALIASES = { correction: 'steering' };

function normalizeCategory(cat) {
  return cat && CATEGORY_ALIASES[cat] ? CATEGORY_ALIASES[cat] : cat;
}

const VALID_TIERS = ['foundation', 'component', 'detail', 'fleeting'];

const VALID_SOURCES = ['human', 'agent', 'hook'];
// R4 outcome — a closed set on purpose. An open string here would drift into
// synonyms ('fail'/'failed'/'didnt work') and the field would stop being
// queryable, which is the same way `topics` decayed into an untyped tag soup.
const VALID_OUTCOMES = ['failed', 'worked'];

function validate(flags) {
  if (flags.cat && !VALID_CATEGORIES.includes(flags.cat)) {
    console.error(`Invalid category "${flags.cat}". Valid: ${VALID_CATEGORIES.join(', ')}`);
    process.exit(1);
  }
  if (flags.tier && !VALID_TIERS.includes(flags.tier)) {
    console.error(`Invalid tier "${flags.tier}". Valid: ${VALID_TIERS.join(', ')}`);
    process.exit(1);
  }
  if (flags.source && !VALID_SOURCES.includes(flags.source)) {
    console.error(`Invalid source "${flags.source}". Valid: ${VALID_SOURCES.join(', ')}`);
    process.exit(1);
  }
  if (flags.outcome && !VALID_OUTCOMES.includes(flags.outcome)) {
    console.error(`Invalid outcome "${flags.outcome}". Valid: ${VALID_OUTCOMES.join(', ')}`);
    process.exit(1);
  }
}

function formatEntry(timestamp, message, category, tier, source, topics, id) {
  const comment = `<!-- cat:${category} topic:${topics || ''} tier:${tier} source:${source} -->`;

  const date = timestamp.slice(0, 10);
  // Lead with `#id`. `pebbl help entry-ids` tells the user every entry has an
  // integer id "printed at log time" and to use it with --relates/--corrects —
  // this is the line that makes that true. Optional so the markdown projection
  // and any other caller without an id in hand still format cleanly.
  const ref = id != null ? `#${id} ` : '';
  let out = `${ref}[${date}] [${tier}|${category}] ${message}`;
  if (topics) out += `\n  topics: ${topics}`;
  return { comment, out };
}

// Print the linear supersession chain for one entry. The chain is followed in
// both directions from the given id: backward via `corrects` to the root
// belief, then forward via `invalidated_by` to the current one. Each link
// shows when it stopped being true and what replaced it, so an agent can read
// the decision's evolution instead of just its latest state.
function printHistory(pebblDir, id) {
  const db = openDb(pebblDir);
  const byId = (n) => db.prepare('SELECT id, timestamp, category, tier, message, corrects, valid_from, valid_to, invalidated_by FROM logs WHERE id = ?').get(n);

  const start = byId(id);
  if (!start) {
    console.error(`pebbl: no entry #${id}`);
    process.exit(1);
  }

  // Walk backward to the root (the earliest belief this one descends from).
  let root = start;
  const seenBack = new Set([root.id]);
  while (root.corrects != null) {
    const prev = byId(root.corrects);
    if (!prev || seenBack.has(prev.id)) break; // guard against cycles
    seenBack.add(prev.id);
    root = prev;
  }

  // Walk forward via invalidated_by, collecting the linear chain root → current.
  const chain = [root];
  const seenFwd = new Set([root.id]);
  let cur = root;
  while (cur.invalidated_by != null) {
    const next = byId(cur.invalidated_by);
    if (!next || seenFwd.has(next.id)) break; // guard against cycles
    seenFwd.add(next.id);
    chain.push(next);
    cur = next;
  }

  console.log(`--- HISTORY: #${id} (${chain.length} link${chain.length === 1 ? '' : 's'}) ---`);
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    const date = (e.valid_from || e.timestamp || '').slice(0, 10);
    const status = e.valid_to == null
      ? 'current'
      : `superseded ${e.valid_to.slice(0, 10)} by #${e.invalidated_by}`;
    const marker = e.id === Number(id) ? ' *' : '';
    console.log(`  #${e.id} [${e.tier}|${e.category}] ${date} — ${e.message}  (${status})${marker}`);
  }
  console.log('---');
}

module.exports = function log(args) {
  const parsed = parseArgs(args);
  // A value-flag given without a value (e.g. `--corrects --cat decision`) must
  // error, not silently drop — a lost --corrects leaves the contradicted entry
  // live. --corrects/--relates must name a real entry (local int or eid);
  // --history is genuinely numeric.
  assertCompleteFlags(parsed);
  assertEntryRefFlags(parsed, ['corrects', 'relates']);
  assertIntegerFlags(parsed, ['history']);
  const { flags, positional } = parsed;

  // Normalize a deprecated category alias (e.g. --cat correction) to its
  // canonical value (steering) BEFORE validation and storage. Input alias only —
  // already-stored rows are never rewritten.
  if (flags.cat) flags.cat = normalizeCategory(flags.cat);

  // `pebbl log --history <id>`: read-only view of a decision's supersession
  // chain. Branches before the message-required check below.
  if (flags.history != null) {
    printHistory(requirePebblDir(), parseInt(flags.history, 10));
    return;
  }

  let message = positional.join(' ').trim();
  if (!message) {
    console.error('Usage: pebbl log "[message]"');
    process.exit(1);
  }

  validate(flags);

  // Write-time secret BLOCK (root fix): an unmarked token-shape in the message
  // must never enter the store (db.sqlite + events.jsonl keep it RAW; the .md
  // redaction only masks the projection). Fires BEFORE any write below, so a
  // blocked log leaves the store byte-for-byte unchanged. `allowlist-secret` on
  // a line exempts it; PEBBL_SECRET_GUARD=warn/off relaxes the gate.
  guardWrite('log', [{ name: 'message', value: message }]);

  const pebblDir = requirePebblDir();

  // Write-time PII SUBSTITUTION, after the secret block and before any write.
  // Unlike a token, a real name does not invalidate the entry — only the name
  // has to go — so this rewrites rather than refuses: blocking would make the
  // author choose between losing the memory and editing around the guard, and
  // people pick "don't write it down", which costs the decision and changes
  // nothing. No name-map means no-op. Every substitution is printed.
  message = guardNames('log', [{ name: 'message', value: message }], { opts: { pebblDir } })[0].value;

  if (isThinEntry(message)) {
    console.error('pebbl: this reads like a spec sheet — consider adding "because..." to explain the rationale');
  }
  ensureProjectFiles(pebblDir);
  const ts = new Date().toISOString();

  // Load the rubric ONCE here: it both classifies this entry (below) and feeds
  // the atomicity gate (atomicityOf, further down), so we don't read it twice.
  const rules = loadRubric(pebblDir);

  let category = flags.cat || null;
  let tier = flags.tier || null;

  // [session] entries are always uncategorized/fleeting — rubric owns this,
  // manual --cat cannot override it. This prevents agents from accidentally
  // tagging session summaries as decisions.
  const isSession = /^\[session\]/i.test(message);
  if (isSession) {
    if (flags.cat && flags.cat !== 'uncategorized') {
      console.error(`pebbl: [session] entries are auto-classified as uncategorized/fleeting — ignoring --cat ${flags.cat}`);
    }
    category = 'uncategorized';
    tier = 'fleeting';
    console.error('pebbl: tip — consider `pebbl handoff` for structured session handoffs with --done/--todo/--blocked');
  } else {
    // --scope foundation explicitly marks an entry as foundational
    if (flags.scope === 'foundation') {
      tier = 'foundation';
    }
    // Always consult rubric for classification. Manual --cat overrides
    // rubric category, but rubric still informs tier when --tier is absent.
    //
    // Primary swap: store the order-INDEPENDENT primary from classifyEntryMulti
    // instead of first-match classifyEntry. CATEGORY_PRIORITY mirrors the default
    // rubric's rule order, so the stored category (and tier) are IDENTICAL on the
    // shipped rubric; the win is that a future rubric reorder can no longer
    // silently re-file an entry by line position (ETC — easier to change safely).
    const classified = classifyEntryMulti(rules, message);
    if (!flags.cat && classified) {
      category = classified.category;
    }
    if (!flags.tier && !flags.scope && classified) {
      tier = classified.tier;
    }
  }

  // Atomicity gate (rubric.atomicityOf — the ONE shared predicate doctor uses
  // too). A non-atomic entry crams several facts into one log. This runs AFTER
  // guardWrite (secrets, above) and AFTER classification, but BEFORE any store
  // write below, so a --strict refusal leaves the store byte-for-byte unchanged.
  //   - default (no --strict): LOSSLESS — still store, then emit ONE
  //     machine-readable advisory to stderr (loom's gate keys on `pebbl-lint:`).
  //   - --strict: do NOT store; print the advisory + a split hint and exit 1.
  // Session/fleeting entries are scoped out inside atomicityOf, so loom's
  // session logging is never refused.
  const atomicity = atomicityOf(rules, message);
  const lintMsg = atomicity.nonAtomic
    ? `pebbl-lint: non-atomic entry (${atomicity.reason}) — prefer one fact per log`
    : null;
  if (atomicity.nonAtomic && flags.strict) {
    console.error(lintMsg);
    console.error('pebbl: --strict refuses multi-fact entries — split into separate atomic `pebbl log` calls (one fact each).');
    process.exit(1);
  }

  // If --corrects is set, inherit category/tier from the corrected entry
  // as a fallback when neither manual flags nor rubric provided them.
  if (flags.corrects) {
    const origDb = openDb(pebblDir);
    const origId = parseInt(flags.corrects, 10);
    const original = origDb.prepare('SELECT category, tier FROM logs WHERE id = ?').get(origId);
    if (original) {
      if (!category) category = original.category;
      if (!tier) tier = original.tier;
    }
  }

  // Auto-detect foundation scope from message language.
  // Fires when tier hasn't been explicitly set by the user.
  if (!flags.scope && !flags.tier) {
    const FOUNDATION_PATTERNS = /\b(the\s+(system|project|codebase|repo|app|application)\s+(uses?|is|was|will|requires?)|all\s+(modules?|services?|components?)|everywhere|project-?wide|system-?wide|monorepo|tech\s*stack)\b/i;
    if (FOUNDATION_PATTERNS.test(message)) {
      tier = 'foundation';
      // System-wide statements like "the project uses X because Y" are
      // decisions even when the rubric doesn't match a decision verb.
      // "uses" is too broad for the general rubric, but scoped to
      // system/project/app language it's a reliable signal.
      if (!category || category === 'uncategorized') {
        category = 'decision';
      }
    }
    // Entries with no topic + decision/structure category are likely project-wide
    if (!tier && !flags.topic) {
      if (category === 'decision' || category === 'structure') {
        tier = 'foundation';
      }
    }
  }

  // When rubric didn't match and no manual tier, use category-based defaults:
  // decision/structure/pattern are architectural → component tier.
  // Everything else → detail.
  if (!category) category = 'uncategorized';
  if (!tier) {
    const SIGNAL_CATEGORIES = ['decision', 'structure', 'pattern'];
    tier = SIGNAL_CATEGORIES.includes(category) ? 'component' : 'detail';
  }

  const source = flags.source || 'human';
  const topics = flags.topic || null;
  // --relates/--corrects accept a local int OR an eid (see args.assertEntryRefFlags).
  // The LEGACY db.sqlite columns are INTEGER FKs over local ids, so only the int
  // form can land there; an eid ref is carried on the event instead, where the
  // eid IS the identity. Parse strictly — a bare parseInt('01KZ...') would yield
  // 1 and silently link the wrong entry.
  const asLocalInt = (v) => (v != null && /^\d+$/.test(String(v).trim()) ? parseInt(v, 10) : null);
  const relatesRef = flags.relates || null;   // raw ref, resolved to an eid on the event
  const correctsRef = flags.corrects || null;
  const relatesTo = asLocalInt(relatesRef);
  const corrects = asLocalInt(correctsRef);

  // Rerank signal (A): importance is tier-derived by default, NOT 0. This is the
  // launch no-regression safety — at launch access_count is 0 everywhere, so the
  // usage term is flat; a tier-derived importance keeps rerank ordering tier-aware
  // so it does not regress below the live tier-then-id ordering on day one.
  // Overridable via --importance <0..5> for a hand-graded entry. importanceForTier
  // lives in rank.js as the single source of truth (the migration backfill reuses
  // it) so the two cannot drift.
  let importance = importanceForTier(tier);
  if (flags.importance !== undefined) {
    const parsed = Number(flags.importance);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5) {
      console.error(`pebbl: --importance expects a number 0..5, got "${flags.importance}"`);
      process.exit(1);
    }
    importance = parsed;
  }

  if (!isSession && !flags.cat && category === 'uncategorized') {
    console.error(`pebbl: no --cat given and rubric didn't match — entry stored as 'uncategorized'`);
    console.error(`       pick one: ${VALID_CATEGORIES.join(', ')}`);
  }

  const db = openDb(pebblDir);

  // On --corrects, the target must still be the current belief (valid_to IS
  // NULL) for the correction to make sense. If it is ALREADY superseded, writing
  // a new open entry here would create a second live belief on the same chain
  // (split-brain), because the stamp's `AND valid_to IS NULL` guard refuses to
  // re-stamp the old target. Detect that case BEFORE inserting anything: follow
  // the chain from the target via invalidated_by to its live head (the still-
  // current entry, valid_to IS NULL), tell the user to correct that head
  // instead, and exit without writing. We do not silently re-target to the head
  // because that would change what the user asked without telling them.
  if (corrects != null) {
    const target = db.prepare('SELECT id, valid_to, invalidated_by FROM logs WHERE id = ?').get(corrects);
    // A truly missing id keeps the existing not-found behavior (fall through and
    // insert with a dangling corrects ref). Only the "exists but already
    // superseded" case is the split-brain we must refuse.
    if (target && target.valid_to != null) {
      // Walk forward to the live head: the entry in this chain whose valid_to
      // is still NULL (same "current belief" notion the reads use).
      let head = target;
      const seen = new Set([head.id]);
      while (head.valid_to != null && head.invalidated_by != null) {
        const next = db.prepare('SELECT id, valid_to, invalidated_by FROM logs WHERE id = ?').get(head.invalidated_by);
        if (!next || seen.has(next.id)) break; // guard against cycles / broken links
        seen.add(next.id);
        head = next;
      }
      console.error(`pebbl: entry #${corrects} is already superseded by #${head.id}; did you mean --corrects ${head.id}?`);
      process.exit(1);
    }
  }

  // R4 — IDENTITY-KEYED ASSERT. `--key K` says "this is the same fact as before,"
  // so a repeat must count, not accumulate. Without this branch the custodian's
  // re-emitted findings pile up (46 copies of one message in ~/loom/.pebbl) and
  // bury the answer they were meant to surface.
  //
  // Identity is scoped to the LIVE belief (`valid_to IS NULL`), the same
  // predicate every read uses: once a fact is superseded its key is free, so a
  // reassert can never resurrect a dead row's count.
  //
  // --corrects is deliberately excluded. That flag means "the belief CHANGED,"
  // which is the opposite of "the same fact again" — silently folding it into a
  // count would drop a correction on the floor.
  const assertKey = (flags.key != null && String(flags.key).trim() !== '')
    ? String(flags.key).trim()
    : null;
  const outcome = flags.outcome || null;
  if (assertKey != null && corrects == null) {
    const live = db.prepare(
      'SELECT id, occurrences FROM logs WHERE assert_key = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1'
    ).get(assertKey);
    if (live) {
      const nextCount = (live.occurrences || 1) + 1;
      db.prepare('UPDATE logs SET occurrences = ? WHERE id = ?').run(nextCount, live.id);
      // FAIL-CLOSED, same contract as the append path below: if the event does
      // not land, undo the count so db.sqlite and events.jsonl stay in lockstep.
      // Nothing else was written — no INSERT, no markdown append — so the
      // rollback is a single decrement.
      try {
        appendReassertEvent(
          pebblDir,
          { ts, actor: undefined, assert_key: assertKey, source },
          (rows) => rebuildEventsView(pebblDir, rows),
        );
      } catch (err) {
        try {
          db.prepare('UPDATE logs SET occurrences = ? WHERE id = ?').run(live.occurrences || 1, live.id);
        } catch (rollbackErr) {
          console.error(`pebbl: ROLLBACK FAILED after event-append failure (${rollbackErr.message}) — db.sqlite and events.jsonl may be out of sync; run pebbl doctor`);
        }
        console.error(`pebbl: reassert NOT recorded — events.jsonl append failed (${err.message})`);
        process.exit(1);
      }
      console.error(`pebbl: same fact as #${live.id} (key ${assertKey}) — counted, not duplicated (${nextCount}x)`);
      return;
    }
  }

  // Mask secret-shapes only in the COMMITTED markdown projection. The DB INSERT
  // below stores the ORIGINAL `message` verbatim — redact() never touches the
  // authoritative store, only the .md the promote gate scans.
  const mdEntry = formatEntry(ts, message, category, tier, source, topics);
  const md = `## ${ts} - ${redact(message)}\n${mdEntry.comment}\n\n`;
  const mdPath = path.join(pebblDir, 'manual-logs.md');
  // Remember the projection's pre-append size so the fail-closed rollback
  // below can truncate this entry back OUT if the event append fails.
  let mdSizeBefore = 0;
  try { mdSizeBefore = fs.statSync(mdPath).size; } catch { /* fresh store */ }
  fs.appendFileSync(mdPath, md);

  // Bi-temporal (v0.5): a new entry is the current belief, valid from now with
  // an open valid_to. importance (v0.7) is set at log time so a fresh row is
  // tier-weighted for rerank immediately; access_count/last_accessed keep their
  // column defaults (0 / NULL) and only move when the entry is surfaced on a read.
  const info = db.prepare(`
    INSERT INTO logs (timestamp, source, category, tier, message, topics, relates_to, corrects, valid_from, valid_to, importance, assert_key, occurrences, outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?)
  `).run(ts, source, category, tier, message, topics, relatesTo, corrects, ts, importance, assertKey, outcome);
  const newId = Number(info.lastInsertRowid);

  // On --corrects, stamp the TARGET's valid_to (when it stopped being true) and
  // invalidated_by (what replaced it) instead of hiding it. The target is known
  // current here (the already-superseded case exited above), so this stamp
  // always lands on a live row.
  if (corrects != null) {
    db.prepare(
      'UPDATE logs SET valid_to = ?, invalidated_by = ? WHERE id = ? AND valid_to IS NULL'
    ).run(ts, newId, corrects);
  }

  // ADDITIVE event-sourcing path (P0 tracer). On TOP of the SQLite write +
  // markdown projection above (which stay canonical for now), also append
  // an `append` event to .pebbl/events.jsonl and rebuild a view from the
  // fold. The whole append+rebuild is serialized by the per-store lock so a
  // concurrent local write can't interleave. db.sqlite remains the source
  // of truth; this proves the committed-text path end to end alongside it.
  //
  // FAIL-CLOSED (fold/db id-drift, write-path root cause): the two stores must
  // move together or not at all. appendLogEvent/appendCorrectLogEvent only
  // THROW when the event was NOT appended (everything after the physical
  // append is best-effort inside events.js), so the catch below can safely
  // roll the canonical write BACK — delete the fresh db row, un-stamp the
  // corrects target, truncate the .md projection — and exit non-zero. The old
  // behavior ("events.jsonl append skipped", row kept) manufactured exactly
  // the phantom db-only row that shifted every later id off the fold's.
  // Declared out here so the display id below can read it after the try/catch.
  let appended = null;
  try {
    // P5 routing: a foundation entry on a PUBLIC remote is private-by-default
    // (lands in events.local.jsonl, gitignored) unless --share is passed. On a
    // private/unknown remote, foundation shares freely (Q3=B). Visibility is
    // detected from the git remote; the detection is cheap and best-effort.
    const repoRoot = path.dirname(path.resolve(pebblDir));
    const vis = detectRemoteVisibility((a) => {
      try {
        return execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { return ''; }
    });
    const local = shouldRouteLocal({ tier, share: !!flags.share, visibility: vis.visibility });
    if (local) {
      console.error('pebbl: foundation entry kept PRIVATE (events.local.jsonl) — public remote, no --share. Use --share to publish.');
    }
    // On --corrects, emit a `correct` event carrying the corrected entry's EID
    // (resolved from the local int inside the lock — events.appendCorrectLogEvent),
    // so the fold stamps the target's valid_to and the superseded entry hides in
    // events/shared reads exactly as the legacy db.sqlite UPDATE above hides it.
    // Without --corrects this stays a plain `append`. The correcting entry IS the
    // new live belief, so it carries the same domain payload either way.
    // `source` rides the event too (present-only, see events.sourceField): the
    // DB row above stores it, so the event must as well or a rebuild-from-
    // events re-labels agent/hook rows as 'human' (fold/db source drift).
    // `relatesRef` rides BOTH paths: a see-also link is orthogonal to a
    // supersession, so `--corrects A --relates B` records both. Each ref is
    // resolved to an eid inside the store lock (events.resolveEntryRef).
    //
    // We keep the append's return value to learn the entry's FOLD id — the
    // number search/context display and the one --relates/--corrects resolve
    // against. It is NOT always db.sqlite's lastInsertRowid: a migrated store
    // has an empty db.sqlite beside a full events log, so the two counters sit
    // far apart and printing the db id would hand the user a ref that resolves
    // to the wrong entry (or to nothing).
    if (correctsRef != null) {
      appended = appendCorrectLogEvent(
        pebblDir,
        { ts, category, tier, message, topics, source, correctsLocalId: correctsRef, relatesRef, assert_key: assertKey, outcome },
        (rows) => rebuildEventsView(pebblDir, rows),
        { local },
      );
    } else {
      appended = appendLogEvent(
        pebblDir,
        { ts, category, tier, message, topics, source, relatesRef, assert_key: assertKey, outcome },
        (rows) => rebuildEventsView(pebblDir, rows),
        { local },
      );
    }
  } catch (err) {
    // The event never landed — roll back the canonical write so db.sqlite,
    // manual-logs.md and events.jsonl stay in lockstep (no orphan db row).
    // Order: un-stamp the corrects target FIRST (restore the prior belief),
    // then delete the new row, then truncate the projection.
    try {
      if (corrects != null) {
        db.prepare(
          'UPDATE logs SET valid_to = NULL, invalidated_by = NULL WHERE id = ? AND invalidated_by = ?'
        ).run(corrects, newId);
      }
      db.prepare('DELETE FROM logs WHERE id = ?').run(newId);
      fs.truncateSync(mdPath, mdSizeBefore);
    } catch (rollbackErr) {
      // A failed rollback is the loud, escalate-don't-hide case: the store IS
      // divergent now and a human must look.
      console.error(`pebbl: ROLLBACK FAILED after event-append failure (${rollbackErr.message}) — db.sqlite and events.jsonl may be out of sync; run pebbl doctor`);
    }
    console.error(`pebbl: entry NOT stored — events.jsonl append failed (${err.message})`);
    process.exit(1);
  }

  // DEFAULT (no --strict) advisory: the entry IS stored (lossless), but we still
  // surface the non-atomic lint so a harness/agent can choose to re-log it as
  // atomic entries. One line, machine-readable, on stderr — never blocks.
  if (lintMsg) console.error(lintMsg);

  // Print the id the READ side uses. In an events store that is the fold's int
  // for this event's eid (what search/context show, what --relates resolves);
  // in a legacy store the fold never ran, so db.sqlite's rowid IS that id.
  let displayId = newId;
  if (appended && appended.event && Array.isArray(appended.rows)) {
    const mine = appended.rows.find((r) => r.eid === appended.event.eid);
    if (mine && mine.id != null) displayId = mine.id;
  }
  console.log(formatEntry(ts, message, category, tier, source, topics, displayId).out);
};

// Rebuild the folded view projection from the event log. P1 fills in the
// rebuild seam P0 cut: write the real, disposable `view.sqlite` (the FK-
// translated read model) from the full fold, alongside the human-readable
// events-view.md tracer. This stays ADDITIVE — the canonical db.sqlite +
// manual-logs.md the existing read path uses are NOT touched here (P6 cutover
// flips openDb to view.sqlite; P1 only proves the artifact rebuilds, and the
// byte-identity vs db.sqlite is proven by the fold-equivalence test, not by
// clobbering the canonical files). Row shape mirrors regenerateMarkdown
// (compact.js:143-159) for the tracer comment block.
function rebuildEventsView(pebblDir, rows) {
  let md = '# Events View (folded)\n\n';
  for (const row of rows) {
    md += `## ${row.timestamp} - ${redact(row.message)}\n`;
    md += `<!-- eid:${row.eid} cat:${row.category} topic:${row.topics} tier:${row.tier} actor:${row.actor} -->\n\n`;
  }
  fs.writeFileSync(path.join(pebblDir, 'events-view.md'), md);

  // Build the disposable view.sqlite from the full fold (the real read model
  // downstream phases consume). Best-effort: never let the additive view break
  // the canonical write — the same contract the appendLogEvent try/catch keeps.
  try {
    const { foldFull } = require('./events');
    const { writeViewSqlite } = require('./view');
    const { readEvents } = require('./events');
    const projection = foldFull(readEvents(pebblDir));
    writeViewSqlite(projection, path.join(pebblDir, 'view.sqlite'));
    // P4: stamp the staleness watermark so the NEXT read sees the view as fresh
    // (a fingerprint compare, no re-fold) instead of replaying the whole log.
    // This runs inside the appendLogEvent lock; writeWatermark/currentState are
    // plain I/O (they don't re-take the lock), so no re-entrancy here.
    const { currentState, writeWatermark } = require('./staleness');
    const state = currentState(pebblDir);
    if (state) writeWatermark(pebblDir, state);
  } catch (err) {
    console.error(`pebbl: view.sqlite rebuild skipped (${err.message})`);
  }
}

module.exports.VALID_CATEGORIES = VALID_CATEGORIES;
module.exports.CATEGORY_ALIASES = CATEGORY_ALIASES;
module.exports.normalizeCategory = normalizeCategory;
module.exports.VALID_TIERS = VALID_TIERS;
module.exports.VALID_SOURCES = VALID_SOURCES;
module.exports.printHistory = printHistory;

function displayEntry(e) {
  const date = (e.timestamp || '').slice(0, 10);
  let out = `[${e.tier}|${e.category}] ${date} — ${e.message}`;
  if (e.topics) out += `\n  topics: ${e.topics}`;
  return out;
}

module.exports.displayEntry = displayEntry;
module.exports.shouldRouteLocal = shouldRouteLocal;
// Reused by log-commit.js so the commit-capture write path rebuilds the SAME
// folded view artifacts this path does (one rebuild seam, no second copy).
module.exports.rebuildEventsView = rebuildEventsView;
