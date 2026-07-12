'use strict';
// `pebbl repair-rollups` — append-only repair for MIS-ROLLED compactions.
//
// The damage class (the loom-store incident, 2026-07-12 ~17:04 UTC): the old
// POSITIONAL int->eid resolver ran a compaction while phantom db-only rows had
// shifted db.sqlite's AUTOINCREMENT ids off the fold's renumbered ids, so the
// supersede events recorded a rolls_up membership SHIFTED off the group the
// rollup TEXT was actually built from. Two symptoms, both invisible until you
// look:
//   - WRONGLY SUPPRESSED: unrelated neighbor entries whose eids landed in a
//     rolls_up they were never part of. The fold hides them, and their content
//     appears in NO rollup's text — real recall loss.
//   - ESCAPED: true group members whose eids were NOT recorded. They stay
//     live even though the rollup's text already carries their content —
//     duplicate recall.
//
// Detection is by row IDENTITY, the same resolution compact.js's
// buildRowEidResolver introduced for the forward fix: a rollup's message is
// `[rollup] <cat> notes on <topic> (<quarter>): <m1>; <m2>; ... .`
// (generateRollupMessage), i.e. the member MESSAGES are embedded verbatim. So
// a recorded member whose own message does not appear as a bounded segment of
// the rollup text was mis-recorded, and a live row whose message DOES appear
// in an already-live rollup's text (written after the row) is an escaped
// duplicate.
//
// The repair is APPEND-ONLY — history is never rewritten (the store's core
// design; corrections are always modeled as new events):
//   - a wrongly-suppressed entry is RESTORED by appending a fresh `append`
//     event carrying the original domain fields (same ts, so it folds back
//     into its place in the timeline) plus a present-only `restores:<eid>`
//     audit field naming the entry it resurrects. The original eid stays
//     hidden by the bogus supersede forever; the restored event is the new
//     live identity.
//   - an escaped duplicate is HIDDEN by appending an `expire` event (the same
//     append-only "drop from the live view" compaction itself uses); its
//     content already lives in the rollup row's text.
// Idempotent: a second run finds every wrongly-suppressed identity already
// live (the restore) and no live escaped rows (the expire), so it plans
// nothing.
//
// DRY-RUN by default, like migrate-to-events: prints the diagnosis + plan and
// writes NOTHING. `--apply` appends the batch under the store lock and
// rebuilds the read model through compact's own seam (which also backfills
// non-event-backed db rows, so the rebuild cannot wipe commits/handoffs).

const { requirePebblDir } = require('./find-pebbl');
const {
  readEvents,
  foldFull,
  appendEventBatch,
  makeAppendEvent,
  makeExpireEvent,
} = require('./events');
const { rebuildReadModelFromEvents } = require('./compact');

// Strip the rollup marker a member message loses when it is concatenated into
// a rollup (generateRollupMessage strips it, so a rollup-of-a-rollup member is
// embedded WITHOUT the prefix).
function stripRollupPrefix(message) {
  return String(message || '').replace(/^\[rollup\]\s*/i, '');
}

// Is `message` embedded in rollup `text` as a WHOLE member segment? Members
// are joined with '; ' after the header's ': ' and the last is closed by the
// final '.', so a real member occurrence is bounded by those delimiters on
// both sides. A bare substring hit (one member's text inside another's) does
// not count — the boundary check is what keeps short messages from matching
// coincidentally. Messages may themselves contain '; ', which is why we match
// the whole candidate against the text instead of splitting the text.
//
// NESTING: a rollup can roll up an EARLIER rollup, whose stripped text is then
// embedded as one member — so a message that was the FINAL member of the inner
// rollup sits in the outer text followed by '..' (the inner close-dot, then
// the outer's), or by '.; ' mid-list. Content carried through a nested rollup
// is still carried, so the after-boundary consumes any run of closing dots
// before requiring '; ' or end-of-text (with at least one dot when at the
// end — the outer rollup's own terminator).
function isMemberSegment(text, message) {
  const m = stripRollupPrefix(message);
  if (!m) return false;
  let idx = text.indexOf(m);
  while (idx !== -1) {
    const before = text.slice(Math.max(0, idx - 2), idx);
    const okBefore = before === ': ' || before === '; ';
    let j = idx + m.length;
    while (text[j] === '.') j += 1; // nested rollups stack close-dots
    const okAfter =
      (j === text.length && j > idx + m.length) || // final member(s), >=1 dot
      text.slice(j, j + 2) === '; ';               // next member follows
    if (okBefore && okAfter) return true;
    idx = text.indexOf(m, idx + 1);
  }
  return false;
}

// ── the pure analysis: events -> { diagnosis, restores, expires } ─────────────
//
// Pure so the test drives it without a store. Returns:
//   diagnosis: per-supersede { eid, ts, members, mismatched } where mismatched
//              lists recorded member eids whose message is not in THIS
//              rollup's text (the shifted-membership signature).
//   restores:  suppressed events to resurrect (content in NO live rollup text
//              and no live row with the same identity).
//   expires:   live rows to hide (message is a member segment of a LIVE
//              rollup row written after them).
function analyzeRollups(events) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const byEid = new Map(list.map((e) => [e.eid, e]));
  const supersedes = list.filter((e) => e.type === 'supersede');
  const supersedeEids = new Set(supersedes.map((e) => e.eid));
  const projection = foldFull(list);

  // Per-supersede membership diagnosis (identity vs recorded eids).
  const diagnosis = [];
  for (const s of supersedes) {
    const members = Array.isArray(s.rolls_up) ? s.rolls_up : [];
    const mismatched = [];
    for (const eid of members) {
      const m = byEid.get(eid);
      if (!m) { mismatched.push({ eid, message: null }); continue; }
      if (!isMemberSegment(s.message || '', m.message)) {
        mismatched.push({ eid, message: m.message || '' });
      }
    }
    if (mismatched.length > 0) {
      diagnosis.push({ eid: s.eid, ts: s.ts, members: members.length, mismatched });
    }
  }

  // LIVE rollup rows: the texts that count as "content preserved". A rollup
  // hidden by a later rollup (or expired) no longer preserves anything on its
  // own — its text must have been folded into its superseder's text.
  const liveRollups = projection.logs
    .filter((r) => supersedeEids.has(r.eid))
    .map((r) => ({ eid: r.eid, ts: r.timestamp, text: r.message || '' }));
  const represented = (message) =>
    liveRollups.some((r) => isMemberSegment(r.text, message));

  // Live-identity multiset — (ts, message) pairs currently in the live view.
  // Consumed per restore-candidate so identical duplicates pair one-to-one,
  // and so a SECOND repair run (whose restored rows are now live) plans
  // nothing (idempotency).
  const liveIdentity = new Map();
  for (const r of projection.logs) {
    const key = `${r.timestamp}\u0000${r.message}`;
    liveIdentity.set(key, (liveIdentity.get(key) || 0) + 1);
  }
  const consumeLive = (key) => {
    const n = liveIdentity.get(key) || 0;
    if (n <= 0) return false;
    liveIdentity.set(key, n - 1);
    return true;
  };

  // WRONGLY SUPPRESSED: hidden by some rolls_up, content in no live rollup
  // text, and not already live under the same identity.
  const suppressed = new Set();
  for (const s of supersedes) {
    for (const eid of (Array.isArray(s.rolls_up) ? s.rolls_up : [])) suppressed.add(eid);
  }
  const restores = [];
  for (const eid of suppressed) {
    const e = byEid.get(eid);
    if (!e) continue; // a rolls_up eid with no event: nothing to restore from
    if (represented(e.message)) continue;
    if (consumeLive(`${e.ts}\u0000${e.message || ''}`)) continue;
    restores.push(e);
  }

  // ESCAPED: live non-rollup rows whose message is a member segment of a live
  // rollup written AFTER them (compaction only ever rolls up pre-existing
  // entries, so the ts guard keeps a genuinely new duplicate alive).
  const expires = [];
  for (const r of projection.logs) {
    if (supersedeEids.has(r.eid)) continue;          // rollup rows stay
    if (r.valid_to != null) continue;                // only current beliefs
    const claimed = liveRollups.some(
      (roll) => (r.timestamp || '') < (roll.ts || '') && isMemberSegment(roll.text, r.message)
    );
    if (claimed) expires.push({ eid: r.eid, id: r.id, ts: r.timestamp, message: r.message });
  }

  return { diagnosis, restores, expires };
}

function truncate(msg, n = 90) {
  const s = String(msg || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = function repairRollups(args = []) {
  // Same gate spelling as migrate-to-events (not parseArgs: --apply is a
  // migration-style flag, not a KNOWN_FLAGS entry). Default is dry-run.
  const apply = args.includes('--apply');
  const pebblDir = requirePebblDir();

  const events = readEvents(pebblDir);
  const { diagnosis, restores, expires } = analyzeRollups(events);

  if (diagnosis.length === 0 && restores.length === 0 && expires.length === 0) {
    console.log('pebbl repair-rollups: every rollup membership matches its text — nothing to repair.');
    return;
  }

  console.log(`pebbl repair-rollups — ${apply ? 'APPLY' : 'DRY-RUN (no changes written)'}`);
  if (diagnosis.length > 0) {
    console.log(`\nMis-rolled supersede event${diagnosis.length === 1 ? '' : 's'} (recorded members not in the rollup's own text):`);
    for (const d of diagnosis) {
      console.log(`  ${d.eid} (${d.ts}) — ${d.mismatched.length}/${d.members} member(s) mismatched`);
    }
  }
  if (restores.length > 0) {
    console.log(`\nWRONGLY SUPPRESSED — ${restores.length} hidden entr${restores.length === 1 ? 'y' : 'ies'} whose content is in NO live rollup (will be restored):`);
    for (const e of restores) {
      console.log(`  ${e.eid} ${String(e.ts).slice(0, 10)} — ${truncate(e.message)}`);
    }
  }
  if (expires.length > 0) {
    console.log(`\nESCAPED DUPLICATES — ${expires.length} live entr${expires.length === 1 ? 'y' : 'ies'} already carried by a rollup's text (will be hidden):`);
    for (const r of expires) {
      console.log(`  #${r.id} ${r.eid} ${String(r.ts).slice(0, 10)} — ${truncate(r.message)}`);
    }
  }

  if (restores.length === 0 && expires.length === 0) {
    // Mismatched membership is still on record (append-only history keeps the
    // bogus supersede forever) but the LIVE state is already correct — e.g. a
    // previous --apply run fixed it. Nothing to write in either mode.
    console.log('\nLive state already consistent (a previous repair covered this) — nothing to write.');
    return;
  }

  if (!apply) {
    console.log('\nNothing was written. Re-run with --apply to append the repair events.');
    return;
  }

  // Build the append-only batch. Restores carry the original domain payload
  // (same ts, so the row folds back into its timeline slot) plus the
  // present-only `restores` audit field; the fold ignores unknown fields, so
  // the event reduces as a plain append. Lesson-tail fields (signature etc.)
  // ride along when the original carried them (makeAppendEvent is
  // present-only about them).
  const batch = [];
  for (const e of restores) {
    batch.push({
      ...makeAppendEvent(pebblDir, {
        ts: e.ts,
        category: e.category,
        tier: e.tier,
        message: e.message,
        topics: e.topics,
        source: e.source,
        signature: e.signature,
        fix_altitude_claimed: e.fix_altitude_claimed,
        changed_files: e.changed_files,
      }),
      restores: e.eid,
    });
  }
  for (const r of expires) {
    batch.push(makeExpireEvent(pebblDir, { target: r.eid }));
  }

  // One locked batch-append + one read-model rebuild — the exact seam
  // compaction itself writes through (rebuild includes the non-event-backed
  // backfill, so commits/handoffs survive).
  appendEventBatch(pebblDir, batch, () => {
    rebuildReadModelFromEvents(pebblDir);
  });

  console.log(`\nRepaired: restored ${restores.length}, hidden ${expires.length} (append-only — originals remain in events.jsonl).`);
};

module.exports.analyzeRollups = analyzeRollups;
module.exports.isMemberSegment = isMemberSegment;
module.exports.stripRollupPrefix = stripRollupPrefix;
