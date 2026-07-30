'use strict';
// Append-only event log — the P0 tracer for inverting pebbl's source of
// truth from binary db.sqlite to a committed text `events.jsonl`.
//
// This is ADDITIVE. db.sqlite stays canonical for now; this file writes an
// `events.jsonl` alongside it and folds it back to rows so the load-bearing
// claim — append-only text merges cleanly under git — can be proven before
// any migration work. P0 handles exactly ONE event type: `append`.
//
// The two hard-won invariants (both failure modes were reproduced during
// design) live here:
//   1. union-merge needs `.pebbl/events.jsonl merge=union` (installed by
//      init) — without it two appends after the same last line CONFLICT.
//   2. The trailing-newline invariant — without it `union` can splice a
//      torn last line into a second line, producing unparseable JSON with
//      exit 0 and no conflict markers. So before every append we repair a
//      missing final newline (a "torn last line").

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ulid } = require('./ulid');
const { withLock } = require('./lock');
const { fold, foldFull } = require('./fold');

const EVENTS_FILE = 'events.jsonl';
// P5 — the PRIVATE half of the two-file split. `events.jsonl` is committed
// (shared, git-transported); `events.local.jsonl` is ALWAYS gitignored and
// never leaves the machine. The fold reads BOTH and unions; git only ever
// carries the shared file. Foundation-tier entries route here by default on a
// public remote (private-by-default), unless `--share` opts them into the
// shared file. This is the documented P5 read-split seam: P1 left readEvents
// single-file, so P5 adds the second-file read at the read entry ONLY — the
// reducer (fold.js) is untouched, it still just receives an events[] array.
const LOCAL_EVENTS_FILE = 'events.local.jsonl';
const ENVELOPE_VERSION = 1;

function eventsPath(pebblDir) {
  return path.join(pebblDir, EVENTS_FILE);
}

function localEventsPath(pebblDir) {
  return path.join(pebblDir, LOCAL_EVENTS_FILE);
}

// actor = <git user.email-short>@<hostname>. The author+source dimension
// shared-write adds, so a folded view can attribute every entry. Email is
// resolved from git config; we take the local-part (before @) to keep it
// short and fall back to $USER if git has no email configured.
function resolveActor(pebblDir) {
  let emailShort = process.env.USER || 'unknown';
  try {
    const email = execFileSync('git', ['config', 'user.email'], {
      cwd: pebblDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (email) emailShort = email.split('@')[0] || email;
  } catch {
    // no git / no email configured — keep the $USER fallback
  }
  const host = (os.hostname() || 'host').split('.')[0];
  return `${emailShort}@${host}`;
}

// Stamp the shared envelope head every event carries: identity (eid), the two
// time dimensions (ts = domain time, the old logs.timestamp; emitted_at =
// append time, the tie-break), type, actor, and the envelope version. Every
// maker below builds ON this one head — one event format, one place to change
// it (DRY). `now` is shared so eid's time prefix and emitted_at agree.
function makeEnvelope(pebblDir, type, { ts, actor } = {}) {
  const now = new Date();
  return {
    eid: ulid(now.getTime()),
    ts: ts || now.toISOString(),
    emitted_at: now.toISOString(),
    type,
    actor: actor || resolveActor(pebblDir),
    v: ENVELOPE_VERSION,
  };
}

// The OPTIONAL lesson fields (Primitive 3, encode). PURELY ADDITIVE: a lesson
// event tagged at task close carries a `signature` (the drift-stable fix-SITE
// key the recurrence command groups on), a `fix_altitude_claimed` (the closing
// agent's own claim — `patch`|`root`|null — NEVER trusted; pebbl OBSERVES the
// real altitude from `changed_files`), and `changed_files` (the merge-diff file
// set the altitude heuristic reads). They ride existing `append`/`correct`
// events. The headline guarantee the additive-fold test pins: an event WITHOUT
// these fields must serialize byte-for-byte as before — so we attach each key
// ONLY when the caller supplied a real value (an undefined/absent field is never
// stamped). `fold.js` mirrors this: it copies a field onto the logs row only
// when the event carries it, so an old row's JSON is unchanged. DRY: both makers
// below build their lesson tail through this one helper, so the shape lives once.
function lessonFields({ signature, fix_altitude_claimed, changed_files } = {}) {
  const out = {};
  if (signature != null && String(signature).trim() !== '') {
    out.signature = String(signature);
  }
  if (fix_altitude_claimed === 'patch' || fix_altitude_claimed === 'root') {
    out.fix_altitude_claimed = fix_altitude_claimed;
  }
  if (Array.isArray(changed_files) && changed_files.length > 0) {
    out.changed_files = changed_files.map((f) => String(f));
  }
  return out;
}

// Optional `source` tail (human|agent|hook). PRESENT-ONLY like lessonFields:
// stamped on the event only when the caller supplied a real value, so an event
// without it serializes byte-for-byte as before. fold.js already reads
// e.source first (row.source = e.source || actorToSource(e)) and defaults to
// 'human' when absent — which is exactly why hook/agent writes must carry it:
// without the field, a rebuild-from-events silently re-labels their rows as
// 'human' (fold/db source drift).
function sourceField({ source } = {}) {
  return source ? { source: String(source) } : {};
}

// Optional R4 assert tail (assert_key / occurrences / outcome). PRESENT-ONLY,
// exactly like lessonFields and sourceField: a field is stamped only when the
// caller supplied a real value, so an event without them serializes
// byte-for-byte as before and an old line folds unchanged. `occurrences` is
// stamped only when it is a meaningful count (>1 would be a lie on a first
// append, so callers pass it only where it is real); the fold's `reassert` case
// owns incrementing thereafter, which keeps ONE writer for the count.
function assertFields({ assert_key, occurrences, outcome } = {}) {
  const out = {};
  if (assert_key != null && String(assert_key).trim() !== '') {
    out.assert_key = String(assert_key);
  }
  if (Number.isInteger(occurrences) && occurrences > 0) {
    out.occurrences = occurrences;
  }
  if (outcome === 'failed' || outcome === 'worked') {
    out.outcome = outcome;
  }
  return out;
}

// Build a `reassert` event — "this exact fact was asserted again." It carries
// ONLY the identity key, never the message: the message already lives on the
// original `append`, and re-shipping it would reintroduce the duplication this
// primitive exists to remove. The fold resolves the key to the live row and
// increments its count; a key with no live row folds to nothing (see fold.js),
// so a reassert can never resurrect a superseded belief or invent a row.
function makeReassertEvent(pebblDir, fields = {}) {
  const { ts, actor, assert_key } = fields;
  return {
    ...makeEnvelope(pebblDir, 'reassert', { ts, actor }),
    assert_key: String(assert_key),
    ...sourceField(fields),
  };
}

// Build an `append` event envelope. Caller supplies the domain fields; the
// envelope head (eid/ts/emitted_at/actor/v) comes from makeEnvelope. The
// optional source + lesson tails (source, signature/fix_altitude_claimed/
// changed_files) are spread in ONLY when present (see sourceField /
// lessonFields) so a plain append is byte-identical to before.
function makeAppendEvent(pebblDir, fields = {}) {
  const { ts, category, tier, message, topics, actor } = fields;
  return {
    ...makeEnvelope(pebblDir, 'append', { ts, actor }),
    category: category || 'uncategorized',
    tier: tier || 'detail',
    message: message || '',
    topics: Array.isArray(topics)
      ? topics
      : (topics ? String(topics).split(',').map((t) => t.trim()).filter(Boolean) : []),
    ...sourceField(fields),
    ...lessonFields(fields),
    ...assertFields(fields),
  };
}

// Build a `correct` event envelope — the new belief, carrying the EID of the
// entry it corrects. Same domain payload as an `append` (the correcting entry
// IS itself a live row in the fold) PLUS the `corrects:<eid>` link the fold
// (src/fold.js, the `correct` case) reads to stamp the target's valid_to so the
// current-belief filter hides the superseded entry — exactly what the legacy
// db.sqlite UPDATE does. `corrects` is ALWAYS an eid on the wire (the only
// shared identity); local ints are per-machine rebuild artifacts, so a raw int
// must never reach here. fold.js's `correct` case reads the SAME field name, so
// it must not drift. Envelope stays v=ENVELOPE_VERSION: a `correct` line is just
// a new type the fold already knows; old `append` lines carry no corrects field
// and fold unchanged (the `append` case never reads it) — backward-compatible.
function makeCorrectEvent(pebblDir, fields = {}) {
  const { ts, category, tier, message, topics, corrects, actor } = fields;
  return {
    ...makeEnvelope(pebblDir, 'correct', { ts, actor }),
    category: category || 'uncategorized',
    tier: tier || 'detail',
    message: message || '',
    topics: Array.isArray(topics)
      ? topics
      : (topics ? String(topics).split(',').map((t) => t.trim()).filter(Boolean) : []),
    corrects: corrects || null,
    // A re-fix recorded as a `correct` (e.g. the GLM-judge saga's later attempt)
    // carries the SAME optional source + lesson tails as an append — additive,
    // present-only.
    ...sourceField(fields),
    ...lessonFields(fields),
  };
}

// Compaction event makers (P3). Each is a pure append onto the log — the
// destructive INSERT/DELETE/UPDATE transaction in compact.js becomes a small
// batch of these. The fold (src/fold.js) is the ONLY reader; these field names
// match exactly what its reducer consumes, so they must not drift:
//   - supersede: `rolls_up:[eid...]` are the source entries this rollup hides;
//     the event itself carries the rollup row's category/tier/message/topics
//     (fold.js emits the surviving rollup row straight off the event). The fold
//     dedups two supersedes that share a rolls_up eid by keeping the
//     lexicographically-smaller eid, so a double compaction is ugly, not broken.
//   - resolve: `target` = the eid whose tier this resolve changes in place
//     (replaces compact.js's UPDATE logs SET tier=...), `tier` the new tier
//     (default 'foundation', matching the old --resolve id:foundation path).
//   - expire: `target` = the eid this removes from the live set (replaces the
//     DELETE of an expired fleeting entry / a --resolve id:rollup drop).
function makeSupersedeEvent(pebblDir, { ts, rolls_up, category, tier, message, topics, actor }) {
  return {
    ...makeEnvelope(pebblDir, 'supersede', { ts, actor }),
    rolls_up: Array.isArray(rolls_up) ? rolls_up.slice() : [],
    category: category || 'uncategorized',
    tier: tier || 'detail',
    message: message || '',
    topics: topics == null ? '' : String(topics),
  };
}

function makeResolveEvent(pebblDir, { ts, target, to_tier, tier, actor }) {
  return {
    ...makeEnvelope(pebblDir, 'resolve', { ts, actor }),
    target: target || null,
    tier: tier || to_tier || 'foundation',
  };
}

function makeExpireEvent(pebblDir, { ts, target, actor }) {
  return {
    ...makeEnvelope(pebblDir, 'expire', { ts, actor }),
    target: target || null,
  };
}

// `commit` event maker — the event-backed form of the git post-commit capture
// (log-commit.js) and of the compact-rebuild backfill for commits rows that
// predate event-backed capture. The wire shape matches EXACTLY what
// migrate-to-events.js has minted for commits-table rows since P2
// (hash/message/files on the standard envelope), so the fold's `commit` case
// reduces migrated and freshly-captured commits identically. `category` is a
// PRESENT-ONLY extra (like sourceField): log-commit classifies the commit
// subject through the rubric for its commit-log.md line, and stamping it on
// the event keeps a regenerated commit-log.md identical to the appended one;
// migrated events without it render with the same defaults as before.
function makeCommitEvent(pebblDir, { ts, hash, message, files, category, actor }) {
  return {
    ...makeEnvelope(pebblDir, 'commit', { ts, actor }),
    hash: hash || '',
    message: message || '',
    files: files || '',
    ...(category ? { category: String(category) } : {}),
  };
}

// Liveness event makers (Primitive 2). Both ride the SAME makeEnvelope head as
// every maker above (eid/ts/emitted_at/actor/v) — additive, never touching an
// existing type. The fold (src/fold.js) builds a `liveness` projection from
// these; the field names here are exactly what its reducer consumes, so they
// must not drift:
//   - liveness-register: declares a cadence contract. `name` is the job key;
//     `every`/`grace` are duration STRINGS on the wire (e.g. '24h', '1h') — the
//     fold parses them, keeping the event human-readable and the math in one
//     place. A registered job that never beats is OVERDUE from its register ts.
//   - heartbeat: a LIVENESS signal, NOT a correctness signal — it asserts a run
//     reached the (end) beat at `ts`. `name` is the job it beats for; `proof`
//     is an optional evidence token (row count / output hash / artifact path)
//     so "beat but no real output" stays inspectable. Correctness stays the job
//     of a separate artifact/freshness check.
function makeLivenessRegisterEvent(pebblDir, { ts, name, every, grace, actor }) {
  return {
    ...makeEnvelope(pebblDir, 'liveness-register', { ts, actor }),
    name: name || '',
    every: every == null ? '' : String(every),
    grace: grace == null ? '' : String(grace),
  };
}

function makeHeartbeatEvent(pebblDir, { ts, name, proof, actor }) {
  return {
    ...makeEnvelope(pebblDir, 'heartbeat', { ts, actor }),
    name: name || '',
    proof: proof == null ? '' : String(proof),
  };
}

// Enforce the trailing-newline invariant and repair a torn final line.
// If the file exists and its last byte is NOT '\n', a previous write (or a
// union merge) left a partial line; we append a '\n' to close it off BEFORE
// the next append, so the new event can never be spliced onto a dangling
// line. Every committed line ends in exactly one LF and is independently
// valid JSON.
function repairTrailingNewline(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return; // nothing to repair
    throw err;
  }
  if (st.size === 0) return;
  const fd = fs.openSync(file, 'r+');
  try {
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, st.size - 1);
    if (buf[0] !== 0x0a) {
      // torn last line: close it with a newline
      fs.writeSync(fd, '\n', st.size);
      fs.fsyncSync(fd);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Append a single event as one LF-terminated JSON line. Low-level: assumes
// the caller already holds the store lock. Repairs a torn final line first
// so the new line is always its own diff hunk. `opts.local` targets the PRIVATE
// events.local.jsonl (P5 private-by-default) instead of the shared file; the
// trailing-newline / torn-line invariant (P0) applies to BOTH files identically.
function appendEvent(pebblDir, event, opts = {}) {
  const file = opts.local ? localEventsPath(pebblDir) : eventsPath(pebblDir);
  repairTrailingNewline(file);
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(file, line);
  return event;
}

// Parse one events file into objects. Skips blank lines. A torn final line is
// tolerated on read. Throws on a genuinely malformed line so corruption is loud.
// Missing file => []. Shared by readEvents for each half of the split.
function readEventsFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`pebbl: malformed event on line ${i + 1} of ${file}: ${err.message}`);
    }
  }
  return events;
}

// Read the FULL event stream: the shared events.jsonl UNIONed with the private
// events.local.jsonl (P5 two-file split). The fold sorts by (ts, emitted_at,
// eid), so concatenation order doesn't matter — local + shared events interleave
// deterministically and the local entries surface in the view exactly like
// shared ones. git only ever transports the shared file; the local file is
// machine-private. eids are globally unique, so there's no collision risk in
// the union. This is the ONLY change the split needs on the read side — the
// reducer in fold.js is untouched.
function readEvents(pebblDir) {
  const shared = readEventsFile(eventsPath(pebblDir));
  const local = readEventsFile(localEventsPath(pebblDir));
  if (local.length === 0) return shared;
  return shared.concat(local);
}

// Deterministic fold: events[] -> view rows. As of P1 the real reducer lives
// in src/fold.js (full 8-type event set, supersession hiding, eid->local-int
// FK translation, the view.sqlite + markdown emitters). It is imported above
// and RE-EXPORTED here so it is reachable from BOTH `require('./events').fold`
// (P3 gates on this) and `require('./fold').fold` (P2/P4/P5/P6 gate on it) —
// both resolve to the exact same reducer; the sequential chain breaks if they
// diverge. `fold` and `foldFull` are the imported references (see top of file).

// The post-append fold+rebuild, made NON-FATAL. Once the event line is on
// disk it IS the durable record; the folded view (events-view.md /
// view.sqlite) is a derived projection the lazy read path (staleness.js
// ensureFresh, wired into openDb) re-materializes on the next read anyway —
// the watermark was never stamped, so the next read refolds. Letting a
// projection failure propagate would break the FAIL-CLOSED contract below:
// callers roll back their canonical write when appendLogEvent THROWS, and
// rolling back a db row whose event DID land re-creates the exact fold/db
// drift (in the other direction) this seam exists to prevent.
function foldAndRebuild(pebblDir, rebuild) {
  try {
    const rows = fold(readEvents(pebblDir));
    if (typeof rebuild === 'function') rebuild(rows);
    return rows;
  } catch (err) {
    console.error(`pebbl: view rebuild skipped (${err.message}) — event appended; the next read refolds`);
    return null;
  }
}

// High-level entry: append one `append` event and rebuild the view inline,
// the whole thing serialized by the per-store lock so a concurrent local
// write can't interleave. `rebuild` is injected by the caller (log.js)
// because the view-rebuild target (markdown/sqlite projection) lives there;
// keeping fold/append decoupled from the projection keeps this module
// reusable for later phases. Returns { event, rows } (rows is null when the
// derived-view rebuild failed — the event itself still landed).
//
// FAIL-CLOSED CONTRACT: a THROW from this function means the event was NOT
// appended (lock acquisition, torn-line repair, or the append itself failed
// before the line hit disk). Everything AFTER the physical append is
// best-effort (foldAndRebuild above), so a caller may roll back its side of
// the write on a throw without creating db/events divergence. log.js relies
// on this to delete the freshly-inserted db row — the phantom-row drift the
// identity resolver tolerates must never be CREATED by this path.
function appendLogEvent(pebblDir, fields, rebuild, opts = {}) {
  return withLock(pebblDir, () => {
    const event = makeAppendEvent(pebblDir, fields);
    // P5: a private entry (foundation, private-by-default on a public remote,
    // no --share) is appended to events.local.jsonl; everything else to the
    // shared events.jsonl. The fold reads BOTH via readEvents, so the row shows
    // up in the view either way — only the git-transport side differs.
    appendEvent(pebblDir, event, { local: !!opts.local });
    const rows = foldAndRebuild(pebblDir, rebuild);
    return { event, rows };
  });
}

// High-level entry for a repeat assert (`pebbl log --key K` where K already has
// a live row). Same lock + fail-closed contract as appendLogEvent: a throw means
// no event was appended, so log.js can roll its canonical UPDATE back.
function appendReassertEvent(pebblDir, fields, rebuild, opts = {}) {
  return withLock(pebblDir, () => {
    const event = makeReassertEvent(pebblDir, fields);
    appendEvent(pebblDir, event, { local: !!opts.local });
    const rows = foldAndRebuild(pebblDir, rebuild);
    return { event, rows };
  });
}

// High-level entry for `pebbl log --corrects N`: append a `correct` event that
// carries the corrected entry's EID, then rebuild the view inline — the whole
// thing under the per-store lock so the eid resolution and the append can't
// interleave with a concurrent write.
//
// THE TRANSLATION (design "IDs" — FK translation, the on-the-wire target MUST be
// an eid): the caller passes `correctsLocalId`, the LOCAL integer the user typed
// (the id they saw in events-mode `context`, which reads view.sqlite). That int
// is a per-machine rebuild artifact; the only shared identity is the eid. So we
// fold the CURRENT event stream (the same reducer the read side uses) to get the
// authoritative eid->int map, invert it, and look up the eid for that int. We do
// this INSIDE the lock and BEFORE appending, so the int resolves against exactly
// the rows the user saw (no concurrent append can shift the mapping underneath).
//
// If the int does not resolve to an eid (a dangling ref, or a row that only
// exists in legacy db.sqlite and was never an event — e.g. a not-yet-migrated
// store), we DOWNGRADE to a plain `append`: the new belief is still logged, just
// without the supersession link, so the additive event path never silently fails
// or stamps the wrong target. The canonical db.sqlite UPDATE in log.js still
// records the legacy correction regardless. Returns { event, rows }.
//
// Same FAIL-CLOSED CONTRACT as appendLogEvent: a throw here means no event
// was appended; the post-append fold/rebuild is best-effort.
function appendCorrectLogEvent(pebblDir, fields, rebuild, opts = {}) {
  return withLock(pebblDir, () => {
    const { correctsLocalId, ...domain } = fields;
    // Resolve local int -> eid via the live fold map (eid is the wire identity).
    let correctsEid = null;
    if (correctsLocalId != null) {
      const { eidToInt } = foldFull(readEvents(pebblDir));
      for (const [eid, int] of eidToInt) {
        if (int === correctsLocalId) { correctsEid = eid; break; }
      }
    }
    // No eid to point at -> log the new belief as a plain append (no link),
    // rather than emit a correct that targets nothing (which folds to a no-op
    // stamp but muddies the wire). With an eid, emit the correct event the fold
    // reads to stamp the target's valid_to.
    const event = correctsEid
      ? makeCorrectEvent(pebblDir, { ...domain, corrects: correctsEid })
      : makeAppendEvent(pebblDir, domain);
    appendEvent(pebblDir, event, { local: !!opts.local });
    const rows = foldAndRebuild(pebblDir, rebuild);
    return { event, rows };
  });
}

// Append a BATCH of pre-built events as one atomic-ish unit and rebuild once.
// Compaction (P3) emits many supersede/resolve/expire events for one --execute
// run; appending them under a SINGLE lock + a SINGLE fold/rebuild is the
// append-only replacement for the old db.transaction (one critical section,
// one view rebuild). Each line still goes through appendEvent, so the
// trailing-newline / torn-line invariant (P0) guards every one — if the batch
// is interrupted mid-write, the next append/fold repairs the torn final line
// and the already-written events stand (no rollback needed, and none possible:
// the log is the durable record). `rebuild(rows)` is injected by the caller so
// events.js stays decoupled from the projection target. Returns {events, rows}.
function appendEventBatch(pebblDir, events, rebuild) {
  return withLock(pebblDir, () => {
    for (const event of events) {
      appendEvent(pebblDir, event);
    }
    const rows = fold(readEvents(pebblDir));
    if (typeof rebuild === 'function') rebuild(rows);
    return { events, rows };
  });
}

module.exports = {
  EVENTS_FILE,
  LOCAL_EVENTS_FILE,
  ENVELOPE_VERSION,
  eventsPath,
  localEventsPath,
  readEventsFile,
  resolveActor,
  makeEnvelope,
  makeAppendEvent,
  makeReassertEvent,
  makeCorrectEvent,
  makeSupersedeEvent,
  makeResolveEvent,
  makeExpireEvent,
  makeCommitEvent,
  makeLivenessRegisterEvent,
  makeHeartbeatEvent,
  repairTrailingNewline,
  appendEvent,
  appendEventBatch,
  readEvents,
  fold,
  foldFull,
  appendLogEvent,
  appendReassertEvent,
  appendCorrectLogEvent,
};
