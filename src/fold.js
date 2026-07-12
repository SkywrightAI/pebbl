'use strict';
// P1 — the full fold: events[] -> {logs, handoffs, commits, narrative}, the
// deterministic read model the whole "text is truth" inversion rests on.
//
// This is NET-NEW events->live-set reduction, not a db read. The bulk of the
// work is supersession semantics (correct chains, double-correct, rollup of a
// rollup, overlapping supersede dedup) and the read-side FK translation:
// relations travel on the wire as eids (the only shared identity), but the
// read side wants INTEGER `id`/`corrects`/`relates_to` so `parseInt`,
// `b.id - a.id`, `ORDER BY id`, and the `valid_to IS NULL` predicate keep
// working unchanged. So at rebuild time we assign LOCAL integers in
// (ts, emitted_at, eid) order and remap every relation through that map.
//
// Determinism is load-bearing (design Risks): same events, any input order ->
// byte-identical rows AND byte-identical markdown on every machine. That is
// what makes never-committed markdown safe to regenerate anywhere. The single
// sort key (ts, emitted_at, eid) is a TOTAL order because eid is a globally
// unique ULID, so there are no real ties to break by an unwritten rule.
//
// STAGING DRIFT (bitemporal v0.5): a `correct` does NOT delete the corrected
// row. It STAMPS the target's valid_to / invalidated_by (the v0.5 model in
// db.js#notCorrected = `valid_to IS NULL`), so the timeline survives and
// `context --as-of` / `log --history` can replay it. The corrected row stays
// in the logs set (and therefore in manual-logs.md, which mirrors ALL rows).
// Only `supersede` (compaction rollup) and `expire` (fleeting DELETE) actually
// REMOVE a row — they reproduce today's destructive DELETEs in compact.js.

const TIER_DEFAULT = 'detail';

// Total-order comparator over the three time/identity dimensions. Identical
// to events.js:150-156 (the P0 fold's sort); duplicated here only so fold.js
// has no cycle back through events.js (events.js re-exports THIS fold). eid is
// the final, globally-unique tie-break, so the order is total and stable.
function compareEvents(a, b) {
  const at = a.ts || '';
  const bt = b.ts || '';
  if (at !== bt) return at < bt ? -1 : 1;
  const ae = a.emitted_at || '';
  const be = b.emitted_at || '';
  if (ae !== be) return ae < be ? -1 : 1;
  const ai = a.eid || '';
  const bi = b.eid || '';
  if (ai !== bi) return ai < bi ? -1 : 1;
  return 0;
}

// Normalize topics to the comma-joined string the rest of pebbl stores in
// logs.topics (TEXT). On the wire `append`/`correct` carry topics as an array;
// older/raw events may already carry the string. Either way out is a string.
function topicsToString(topics) {
  if (Array.isArray(topics)) return topics.join(',');
  return topics == null ? '' : String(topics);
}

// The closed event set P1 folds. Anything else is ignored (Acceptance #1:
// "unknown types are ignored, not thrown").
const KNOWN_TYPES = new Set([
  'append', 'correct', 'supersede', 'resolve', 'expire',
  'handoff-open', 'handoff-close', 'narrative-set',
  // Primitive 2 (liveness). ADDITIVE: these reduce into the `liveness` side
  // channel ONLY, never into the logs/handoffs/commits/narrative outputs — so a
  // stream WITHOUT them folds byte-identically to before, and a stream WITH them
  // leaves every existing projection untouched. A registry of cadence contracts
  // (`liveness-register`) plus the heartbeats that satisfy them (`heartbeat`).
  'liveness-register', 'heartbeat',
  // Commit capture. migrate-to-events has minted `commit` events since P2 and
  // log-commit.js appends one per captured commit; folding them into the
  // `commits` side channel is what lets a rebuild-from-events REGENERATE the
  // commits table + commit-log.md instead of wiping them (the incident where
  // compaction's rebuild destroyed every captured-commit row). Side channel
  // ONLY — the logs projection is untouched, so a stream without them folds
  // byte-identically to before.
  'commit',
]);

// ── the reducer ──────────────────────────────────────────────────────────────
//
// Returns an ARRAY of folded log rows (the P0 contract every existing test
// asserts against: rows.map(r => r.message), rows.length, rows[0].eid). The
// array also carries non-enumerable side channels (handoffs, commits,
// narrative) so callers that need the full projection can read them without
// breaking the array shape. view.sqlite + the 4 markdown files are emitted by
// foldFull() below, which returns the structured object.
function fold(events) {
  return foldFull(events).logs;
}

// Full projection: every table + the narrative, plus the eid->int map. Pure;
// no I/O. foldFull(events) is deterministic in input order.
function foldFull(events) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const sorted = list.slice().sort(compareEvents);

  // First pass — collect which eids are HIDDEN-by-removal (rolled up or
  // expired) and the supersede dedup, so a single forward pass can build the
  // surviving set. A rolled-up/expired row must not appear at all (it mirrors
  // today's DELETE); a corrected row DOES appear but stamped (bitemporal).

  // supersede dedup: two supersedes may claim overlapping rolls_up sets
  // (concurrent compaction). Keep the lexicographically-smaller supersede eid
  // as the winner for each rolled-up source; the loser's rollup row is dropped.
  const rolledUpBy = new Map();      // sourceEid -> winning supersede eid
  for (const e of sorted) {
    if (e.type !== 'supersede') continue;
    const sup = e.eid || '';
    const sources = Array.isArray(e.rolls_up) ? e.rolls_up : [];
    for (const src of sources) {
      const prev = rolledUpBy.get(src);
      if (prev === undefined || sup < prev) rolledUpBy.set(src, sup);
    }
  }
  // A supersede event "wins" if it is the chosen (smaller) supersede for at
  // least one of its sources; a fully-dominated duplicate rollup is dropped so
  // it does not emit a phantom rollup row (design: "dedup overlapping rollups
  // by keeping the lexicographically-smaller supersede eid").
  const winningSupersede = new Set(rolledUpBy.values());

  const removed = new Set();         // eids that must NOT appear as a row
  for (const [src, sup] of rolledUpBy) {
    void sup;
    removed.add(src);
  }
  for (const e of sorted) {
    if (e.type === 'expire') {
      const t = e.target || e.expires || e.eid_target;
      if (t) removed.add(t);
    }
  }

  // ── forward pass: build rows in surviving order ──
  // rowsByEid lets correct/resolve/supersede point back at an earlier row.
  const rows = [];
  const rowByEid = new Map();
  const handoffByEid = new Map();
  const handoffs = [];
  const commits = [];
  let narrative = null;
  // Liveness projection (Primitive 2): name -> { every, grace, registered_at,
  // last_beat, last_proof }. A side channel like commits/narrative — it does NOT
  // touch the logs array, so existing projections stay byte-identical. `sorted`
  // is in (ts, emitted_at, eid) order, so the LAST register wins (re-register
  // updates the cadence) and the LAST heartbeat sets last_beat deterministically.
  // A registered job with last_beat=null never beat -> overdue from registered_at.
  const liveness = new Map();

  function pushLogRow(e, overrides) {
    const row = {
      eid: e.eid,
      timestamp: e.ts,
      actor: e.actor || '',
      source: e.source || actorToSource(e),
      category: e.category || 'uncategorized',
      tier: e.tier || TIER_DEFAULT,
      message: e.message || '',
      topics: topicsToString(e.topics),
      // relations stay as eids HERE; remapped to ints in the FK pass below.
      correctsEid: e.corrects || null,
      relatesToEid: e.relates_to || null,
      valid_from: e.valid_from || e.ts,
      valid_to: null,
      invalidatedByEid: null,
      __order: rows.length,
      ...overrides,
    };
    // Optional lesson tail (Primitive 3, encode). ADDITIVE + present-only: a key
    // is copied onto the row ONLY when the event carries it, so an event without
    // these fields produces a byte-identical row (the additive-fold guarantee the
    // encode test pins). `recurrence` reads these off the folded rows to group by
    // fix-SITE signature and to OBSERVE altitude from changed_files (never from
    // the agent's fix_altitude_claimed). events.js only ever stamps these on an
    // append/correct when present, so the guard here is the symmetric read side.
    if (typeof e.signature === 'string' && e.signature !== '') {
      row.signature = e.signature;
    }
    if (e.fix_altitude_claimed === 'patch' || e.fix_altitude_claimed === 'root') {
      row.fix_altitude_claimed = e.fix_altitude_claimed;
    }
    if (Array.isArray(e.changed_files) && e.changed_files.length > 0) {
      row.changed_files = e.changed_files.slice();
    }
    rows.push(row);
    rowByEid.set(e.eid, row);
    return row;
  }

  for (const e of sorted) {
    if (!KNOWN_TYPES.has(e.type)) continue;          // unknown: ignore
    if (removed.has(e.eid)) {
      // This row was rolled up or expired by a later event; never emit it.
      continue;
    }
    switch (e.type) {
      case 'append': {
        pushLogRow(e);
        break;
      }
      case 'correct': {
        // The correcting entry is itself a live row (the new belief).
        const row = pushLogRow(e);
        // Stamp the target it corrects: valid_to = this correction's ts,
        // invalidated_by = this entry. Bitemporal — target row STAYS. Guard
        // matches the write path's `AND valid_to IS NULL`: only stamp a still-
        // current target, so a double-correct on an already-superseded entry
        // does not re-stamp (3-link chain A<-B<-C keeps A stamped at B).
        const target = rowByEid.get(e.corrects);
        if (target && target.valid_to == null) {
          target.valid_to = e.ts;
          target.invalidatedByEid = e.eid;
        }
        break;
      }
      case 'supersede': {
        // Compaction rollup. The sources are already in `removed` (hidden).
        // Emit the rollup row only if THIS supersede won the dedup; a fully
        // dominated duplicate emits nothing.
        if (!winningSupersede.has(e.eid)) break;
        pushLogRow(e, {
          source: e.source || 'agent',
          tier: e.tier || TIER_DEFAULT,
        });
        break;
      }
      case 'resolve': {
        // In-place tier change — replaces compact.js:292's UPDATE logs SET
        // tier='foundation'. Target the row whose eid this resolve names.
        const target = rowByEid.get(e.target || e.resolves);
        if (target) target.tier = e.tier || 'foundation';
        break;
      }
      case 'expire': {
        // Already handled by the `removed` set above; nothing to emit.
        break;
      }
      case 'handoff-open': {
        const h = {
          eid: e.eid,
          timestamp: e.ts,
          summary: e.summary || '',
          done: e.done || null,
          todo: e.todo || null,
          blocked: e.blocked || null,
          topics: topicsToString(e.topics) || null,
          source: e.source || 'agent',
          // session refs travel as eids; remapped to local ints in the FK pass.
          sessionEntryEids: Array.isArray(e.session_entries) ? e.session_entries.slice() : [],
          sessionCommits: Array.isArray(e.session_commits) ? e.session_commits.slice() : [],
          docs: e.docs || null,
          status: 'open',
          closed_at: null,
          __order: handoffs.length,
        };
        handoffs.push(h);
        handoffByEid.set(e.eid, h);
        break;
      }
      case 'handoff-close': {
        const h = handoffByEid.get(e.handoff || e.target);
        if (h) {
          h.status = 'closed';
          h.closed_at = e.ts;
        }
        break;
      }
      case 'commit': {
        // Captured git commit -> a commits-table row. Field names mirror the
        // db schema (timestamp/hash/message/files); category is the optional
        // rubric classification log-commit stamps (present-only) so the
        // regenerated commit-log.md line matches the appended one. `sorted`
        // order makes the row order (and the ids assigned below)
        // deterministic. No dedup: two capture events are two rows, exactly
        // like two INSERTs were.
        const row = {
          eid: e.eid,
          timestamp: e.ts,
          hash: e.hash || '',
          message: e.message || '',
          files: e.files || '',
        };
        if (typeof e.category === 'string' && e.category !== '') {
          row.category = e.category;
        }
        commits.push(row);
        break;
      }
      case 'narrative-set': {
        // Latest write wins (sorted order makes "latest" deterministic).
        narrative = {
          text: e.text || e.body || '',
          refsEids: Array.isArray(e.refs) ? e.refs.slice() : [],
          updated: e.ts,
        };
        break;
      }
      case 'liveness-register': {
        // Declare/refresh a cadence contract. Keyed by name; a later register
        // overwrites the cadence (the LAST one in sorted order wins) but never
        // clears an already-seen heartbeat — registration and beats are
        // independent. The first register seeds registered_at (the floor a
        // never-beat job is measured against). `every`/`grace` stay STRINGS
        // here (the wire form); the liveness command parses durations.
        if (!e.name) break;
        const cur = liveness.get(e.name) || {
          name: e.name, registered_at: e.ts,
          last_beat: null, last_proof: null,
        };
        cur.every = e.every == null ? '' : String(e.every);
        cur.grace = e.grace == null ? '' : String(e.grace);
        cur.registered_at = e.ts;            // sorted order: latest register ts
        liveness.set(e.name, cur);
        break;
      }
      case 'heartbeat': {
        // A liveness beat for a job. A beat can arrive for a name that was never
        // registered (e.g. the job beats before someone registers the cadence);
        // we still record last_beat so a later register projects a fresh job.
        // last_beat is the LATEST ts (sorted order makes "latest" deterministic).
        if (!e.name) break;
        const cur = liveness.get(e.name) || {
          name: e.name, every: '', grace: '',
          registered_at: null, last_beat: null, last_proof: null,
        };
        cur.last_beat = e.ts;
        cur.last_proof = e.proof == null ? '' : String(e.proof);
        liveness.set(e.name, cur);
        break;
      }
      default:
        break;
    }
  }

  // ── FK translation: assign LOCAL integers in surviving (ts,emitted_at,eid)
  // order, then remap every relation eid through the map. logs.id stays a
  // 1-based AUTOINCREMENT-style integer; corrects/relates_to/invalidated_by
  // resolve to those ints (or null when the referent is gone). Handoff session
  // refs resolve the same way. The integer is a per-machine rebuild artifact;
  // the eid is the only shared identity. (design "IDs" FK-translation para.)
  const eidToInt = new Map();
  let nextId = 1;
  for (const row of rows) {
    eidToInt.set(row.eid, nextId);
    row.id = nextId;
    nextId += 1;
  }
  const toInt = (eid) => (eid != null && eidToInt.has(eid) ? eidToInt.get(eid) : null);

  for (const row of rows) {
    row.corrects = toInt(row.correctsEid);
    row.relates_to = toInt(row.relatesToEid);
    row.invalidated_by = toInt(row.invalidatedByEid);
    delete row.correctsEid;
    delete row.relatesToEid;
    delete row.invalidatedByEid;
    delete row.__order;
  }

  // Handoffs get their own local integer space (mirrors the separate
  // handoffs.id AUTOINCREMENT). session_entries map through the SAME logs
  // eid->int map (they reference log rows), per-element, dropping any ref whose
  // target did not survive — a first-class array, not a footnote (design Risks).
  let nextHid = 1;
  for (const h of handoffs) {
    h.id = nextHid;
    nextHid += 1;
  }
  for (const h of handoffs) {
    h.session_entries = h.sessionEntryEids.map(toInt).filter((n) => n != null);
    h.session_commits = h.sessionCommits.slice();
    delete h.sessionEntryEids;
    delete h.sessionCommits;
    delete h.__order;
  }

  // Commits get their own local integer space too (mirrors the separate
  // commits.id AUTOINCREMENT); rows are already in deterministic
  // (ts, emitted_at, eid) order from the sorted pass.
  let nextCid = 1;
  for (const c of commits) {
    c.id = nextCid;
    nextCid += 1;
  }

  // narrative refs are foundation log refs -> local ints.
  if (narrative) {
    narrative.refs = narrative.refsEids.map(toInt).filter((n) => n != null);
    delete narrative.refsEids;
  }

  // Liveness projection -> a name-sorted array (deterministic regardless of
  // input order, like every other projection). Each entry is a registry row the
  // `liveness check` command walks. Empty when no liveness events are present,
  // so existing callers that never read it are unaffected.
  const livenessRows = [...liveness.values()].sort((a, b) =>
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );

  return { logs: rows, handoffs, commits, narrative, liveness: livenessRows, eidToInt };
}

// Map an event's actor/origin to the legacy `source` column when an explicit
// source is absent. Append events from `pebbl log` are 'human' by default in
// the old path; hooks are 'hook'; agents 'agent'. We can't always recover this
// from the envelope, so default to 'human' for appends (the manual-log path)
// to match regenerateMarkdown's expectations; callers pass source explicitly
// when they know better.
function actorToSource(e) {
  if (e && e.source) return e.source;
  return 'human';
}

module.exports = {
  fold,
  foldFull,
  compareEvents,
  topicsToString,
  KNOWN_TYPES,
};
