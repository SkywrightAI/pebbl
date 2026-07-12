'use strict';
// P2 — `pebbl migrate-to-events`: lift a binary `db.sqlite` store into the
// canonical append-only `events.jsonl` so the real cutover (P6) has a lossless,
// auditable on-ramp.
//
// Contract (notes/design-event-sourcing-2026-06-17.md, P2 bullet + Resolved
// decisions):
//   - DRY-RUN by default: prints an audit + plan, mutates NOTHING on disk.
//     A real run is behind an explicit `--apply`/`--write` flag.
//   - Per-store SAME-SNAPSHOT pre-migration FK audit that ABORTS the whole
//     store (non-zero exit, no partial events.jsonl) on ANY dangling reference.
//   - The oldInt->ULID map is built FULLY before any remap, with time-seeded
//     ULIDs so event sort order matches legacy (timestamp, id) order (no
//     forward-reference can dangle because a target was not minted yet).
//   - Remap ALL FIVE FK sites: logs.relates_to, logs.corrects,
//     handoffs.promoted_log_id, and PER-ELEMENT handoffs.session_entries
//     (logs.id ints -> append/correct eids) and handoffs.session_commits
//     (commit hashes -> minted `commit` event eids).
//   - commits table rows -> `commit` events.
//   - The 36 free-text `correction`-category entries migrate as plain `append`
//     events (Q1=A, no heuristic linking) — ONLY explicit logs.corrects ints
//     produce `correct` events.
//   - ADDITIVE: never delete db.sqlite. On a real run, rename db.sqlite ->
//     legacy-db.sqlite as the rollback artifact. Idempotent: a second run on
//     an already-migrated store is a safe no-op.
//
// STAGING DRIFT (bitemporal v0.5): the logs table carries valid_from / valid_to
// / invalidated_by. valid_to/invalidated_by are DERIVED by the fold from the
// `correct` events (fold.js stamps the target's valid_to = the correction's ts,
// invalidated_by = the correcting eid), exactly as the legacy v0.5 write path
// does (log.js:259-263) and the v0.5 backfill (migrate.js:81-86). So we do NOT
// re-emit valid_to as an event field — we emit the `correct` link with the
// correcting row's timestamp as `ts` and let the fold re-derive it. We DO stamp
// valid_from per row so plain appends reproduce db's valid_from.
//
// SOURCE SEAM (carried from P1): P0's append envelope dropped `source`, so the
// fold defaulted rows to human. But db.sqlite HAS the real per-row `source`
// (human/agent/hook) and the current fold READS event.source first
// (fold.js:130 `source: e.source || actorToSource(e)`). So we STAMP `source`
// onto every migrated event — the log is lossless AND fold-level source parity
// closes. No fold change needed.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const { requirePebblDir } = require('./find-pebbl');
const { ulid } = require('./ulid');
const { withLock } = require('./lock');
const { appendEvent, resolveActor, eventsPath, ENVELOPE_VERSION } = require('./events');
// DRY: the positive completeness marker name lives in store-mode.js (the reader
// of it) so init, migrate, and the predicate never drift on the filename.
const { EVENTS_CANONICAL_MARKER } = require('./store-mode');

const LEGACY_DB = 'legacy-db.sqlite';
// A pre-existing events.jsonl on an UN-migrated store is the P0 TRACER log —
// `pebbl log` appends an `append` event on every call (log.js:273, always on).
// It is partial (no commits/handoffs/corrects, no FK remap, throwaway eids), so
// it is NOT a completed migration. The migration writes a fresh CANONICAL log;
// we move the tracer aside to this .bak so it isn't double-counted.
const TRACER_BAK = 'events.tracer.bak.jsonl';
// When `--repair` alters or drops any FK ref, we write a MANIFEST naming exactly
// what was repaired/dropped (handoff/log id + hash) so the relaxation from strict
// is auditable and never silent. Mandatory whenever anything is repaired/dropped.
const REPAIR_MANIFEST = 'repair-manifest.json';

// ── helpers ──────────────────────────────────────────────────────────────────

// A real run is gated behind an explicit flag; default is dry-run. We accept
// both spellings the contract named (`--apply` / `--write`).
function wantsApply(args) {
  return args.includes('--apply') || args.includes('--write');
}

// The relaxed mode: handle dangling FK refs deterministically (git-recover a
// commit, else drop the single ref) instead of aborting the whole store. STRICT
// abort stays the DEFAULT — this is opt-in only.
function wantsRepair(args) {
  return args.includes('--repair');
}

// Parse a JSON array column (session_entries / session_commits / docs). Stored
// as a JSON-stringified array in a TEXT column (handoff.js:200-202); NULL/empty
// means no refs. A malformed value is loud, not silent — corruption must abort.
function parseJsonArray(value, label, handoffId) {
  if (value == null || value === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new MigrationAbort(
      `handoff #${handoffId}: ${label} is not valid JSON (${err.message})`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new MigrationAbort(`handoff #${handoffId}: ${label} is not a JSON array`);
  }
  return parsed;
}

// A loud abort that carries a non-zero exit contract. Thrown by the audit (and
// by malformed JSON) so the store leaves NO partial events.jsonl behind.
class MigrationAbort extends Error {}

// Time-seeded ULID: seed the 48-bit time prefix from the row's domain
// timestamp so event lexical order tracks legacy chronological order. Ties on
// the same ms are broken by `emitted_at` (a monotonic per-row counter, below),
// which is the fold's secondary sort key — so the surviving fold order matches
// legacy (timestamp, id) order exactly.
function tsToMillis(ts) {
  const ms = Date.parse(ts || '');
  return Number.isNaN(ms) ? 0 : ms;
}

// ── reading the store (one snapshot) ──────────────────────────────────────────

// Read every table we migrate in deterministic order. logs and commits in
// (timestamp, id) order — the recency order the read side relies on. handoffs
// in id order. One open db, one snapshot, so the audit and the build see the
// exact same rows (the contract's "per-store SAME-SNAPSHOT" requirement).
function readSnapshot(db) {
  const logs = db.prepare(
    'SELECT id, timestamp, source, category, tier, message, topics, relates_to, corrects, valid_from, valid_to, invalidated_by FROM logs ORDER BY timestamp ASC, id ASC'
  ).all();
  const commits = db.prepare(
    'SELECT id, timestamp, hash, message, files FROM commits ORDER BY timestamp ASC, id ASC'
  ).all();
  const handoffs = db.prepare(
    'SELECT id, timestamp, summary, done, todo, blocked, topics, source, session_entries, session_commits, status, closed_at, promoted_log_id, docs FROM handoffs ORDER BY id ASC'
  ).all();
  return { logs, commits, handoffs };
}

// ── the per-store FK audit (same snapshot, loud abort) ────────────────────────

// Assert EVERY foreign-key integer resolves to a surviving row BEFORE any event
// is built or written. Returns a structured audit report (counts + the resolved
// reference sets) for the dry-run plan; THROWS MigrationAbort on the first
// dangling reference so the store aborts whole (non-zero exit, no partial log).
//
// Five FK sites (design Approach): logs.relates_to, logs.corrects,
// handoffs.promoted_log_id (logs.id ints), and PER-ELEMENT
// handoffs.session_entries (logs.id ints) and handoffs.session_commits (commit
// hashes — a DISTINCT id space, resolved against the commits table, not logs).
function auditForeignKeys(snapshot) {
  const { logs, commits, handoffs } = snapshot;

  const logIds = new Set(logs.map((r) => r.id));
  const commitHashes = new Set(commits.map((c) => c.hash));

  const report = {
    logs: logs.length,
    commits: commits.length,
    handoffs: handoffs.length,
    relatesTo: 0,
    corrects: 0,
    promotedLogId: 0,
    sessionEntries: 0,
    sessionCommits: 0,
    corrections: 0, // free-text 'correction'-category logs WITHOUT a corrects int
  };

  const need = (set, id, what) => {
    if (id == null) return;
    if (!set.has(id)) {
      throw new MigrationAbort(`dangling reference: ${what} -> ${id} (no surviving target)`);
    }
  };

  for (const row of logs) {
    if (row.relates_to != null) { need(logIds, row.relates_to, `logs#${row.id}.relates_to`); report.relatesTo += 1; }
    if (row.corrects != null) { need(logIds, row.corrects, `logs#${row.id}.corrects`); report.corrects += 1; }
    if (row.category === 'correction' && row.corrects == null) report.corrections += 1;
  }

  for (const h of handoffs) {
    if (h.promoted_log_id != null) { need(logIds, h.promoted_log_id, `handoffs#${h.id}.promoted_log_id`); report.promotedLogId += 1; }
    const entries = parseJsonArray(h.session_entries, 'session_entries', h.id);
    for (const e of entries) {
      need(logIds, e, `handoffs#${h.id}.session_entries[]`);
      report.sessionEntries += 1;
    }
    const shCommits = parseJsonArray(h.session_commits, 'session_commits', h.id);
    for (const c of shCommits) {
      if (!commitHashes.has(c)) {
        throw new MigrationAbort(`dangling reference: handoffs#${h.id}.session_commits[] -> ${c} (no surviving commit)`);
      }
      report.sessionCommits += 1;
    }
  }

  return report;
}

// ── --repair: handle dangling FK refs deterministically (opt-in) ──────────────

// Try to RECOVER an orphaned commit hash by re-scanning git: if the object is
// still reachable in the repo we read its real metadata and backfill a minimal
// `commits` row (same shape readSnapshot produces: id/timestamp/hash/message/
// files). Returns the row on success, or null if the hash is unrecoverable
// (object gone, not a git repo, git unavailable) so the caller falls to drop.
//
// `nextId` keeps the synthetic id space disjoint from the real commits table so
// the recovered row can't collide with a surviving row's id (id is only used to
// break mint-order ties; the eid is keyed on the hash, which is the FK).
function recoverCommitFromGit(repoRoot, hash, nextId) {
  let out;
  try {
    // %H full hash, %cI committer ISO-8601 date, %s subject. --no-walk so we
    // read exactly this object, not its history. A bad/unreachable hash exits
    // non-zero -> caught -> null (unrecoverable).
    out = execFileSync(
      'git',
      ['log', '-1', '--no-walk', '--format=%H%x09%cI%x09%s', hash],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return null; // unreachable object, or not a git repo / no git
  }
  if (!out) return null;
  const tab = out.indexOf('\t');
  const tab2 = out.indexOf('\t', tab + 1);
  if (tab < 0 || tab2 < 0) return null;
  const fullHash = out.slice(0, tab);
  const ts = out.slice(tab + 1, tab2);
  const subject = out.slice(tab2 + 1);
  // best-effort file list; absence must not fail the recovery.
  let files = '';
  try {
    files = execFileSync(
      'git',
      ['show', '--name-only', '--format=', hash],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim().split('\n').filter(Boolean).join(',');
  } catch { /* leave files empty */ }
  // Key the recovered row on the ORIGINAL stored hash so the existing per-element
  // session_commits remap (which looks up by the stored hash) resolves. We keep
  // the full hash around in the manifest for the human auditing the repair.
  return { row: { id: nextId, timestamp: ts, hash, message: subject, files }, fullHash };
}

// MUTATE the snapshot so the build pass sees a clean graph: git-recover orphaned
// commit hashes (backfill a commits row), and for every other dangling FK site
// drop/NULL the single offending ref. Returns a MANIFEST of every change. The
// snapshot's logs/commits/handoffs arrays are edited IN PLACE so buildIdMaps /
// buildEvents downstream operate on the repaired graph and never re-throw.
//
// Policy per FK site (every site auditForeignKeys covers):
//   logs.relates_to        dangling -> NULL the back-link (drop the relation)
//   logs.corrects          dangling -> NULL it (row becomes a plain append, not
//                          a correct — no invented link)
//   handoffs.promoted_log_id dangling -> NULL it
//   handoffs.session_entries[] dangling -> drop the element
//   handoffs.session_commits[] orphan hash -> RECOVER from git (backfill a
//                          commit row) else DROP the element
function repairForeignKeys(snapshot, repoRoot) {
  const { logs, commits, handoffs } = snapshot;

  const logIds = new Set(logs.map((r) => r.id));
  const commitHashes = new Set(commits.map((c) => c.hash));
  // Next synthetic id for any commit row we recover, disjoint from real ids.
  let nextCommitId = commits.reduce((m, c) => Math.max(m, c.id || 0), 0) + 1;

  const manifest = {
    recovered_commits: [], // { handoff, hash, fullHash }
    dropped_commits: [],   // { handoff, hash }   (unrecoverable -> element dropped)
    dropped_session_entries: [], // { handoff, logId }
    dropped_relates_to: [], // { logId, target }
    dropped_corrects: [],   // { logId, target }
    dropped_promoted_log_id: [], // { handoff, target }
  };

  // logs.relates_to / logs.corrects — NULL a dangling back-link.
  for (const row of logs) {
    if (row.relates_to != null && !logIds.has(row.relates_to)) {
      manifest.dropped_relates_to.push({ logId: row.id, target: row.relates_to });
      row.relates_to = null;
    }
    if (row.corrects != null && !logIds.has(row.corrects)) {
      manifest.dropped_corrects.push({ logId: row.id, target: row.corrects });
      row.corrects = null;
    }
  }

  for (const h of handoffs) {
    // handoffs.promoted_log_id — NULL a dangling promotion link.
    if (h.promoted_log_id != null && !logIds.has(h.promoted_log_id)) {
      manifest.dropped_promoted_log_id.push({ handoff: h.id, target: h.promoted_log_id });
      h.promoted_log_id = null;
    }

    // handoffs.session_entries[] — drop each dangling log-id element. These are
    // logs.id ints; a dangling one points at a row that no longer exists, so the
    // back-link is dropped (the surviving entries are untouched).
    const entries = parseJsonArray(h.session_entries, 'session_entries', h.id);
    const keptEntries = [];
    for (const e of entries) {
      if (logIds.has(e)) { keptEntries.push(e); continue; }
      manifest.dropped_session_entries.push({ handoff: h.id, logId: e });
    }
    if (keptEntries.length !== entries.length) {
      h.session_entries = JSON.stringify(keptEntries);
    }

    // handoffs.session_commits[] — recover orphan hashes from git, else drop.
    const shCommits = parseJsonArray(h.session_commits, 'session_commits', h.id);
    const keptCommits = [];
    let mutatedCommits = false;
    for (const c of shCommits) {
      if (commitHashes.has(c)) { keptCommits.push(c); continue; }
      const recovered = recoverCommitFromGit(repoRoot, c, nextCommitId);
      if (recovered) {
        nextCommitId += 1;
        commits.push(recovered.row);
        commitHashes.add(c);
        keptCommits.push(c);
        manifest.recovered_commits.push({ handoff: h.id, hash: c, fullHash: recovered.fullHash });
      } else {
        // unrecoverable convenience back-link -> drop the single element.
        manifest.dropped_commits.push({ handoff: h.id, hash: c });
        mutatedCommits = true;
      }
    }
    if (mutatedCommits) h.session_commits = JSON.stringify(keptCommits);
  }

  // Keep the recovered commits in deterministic (timestamp, id) order so the
  // build pass mints eids in the same order it would for a clean store.
  commits.sort((a, b) => {
    const at = a.timestamp || '';
    const bt = b.timestamp || '';
    if (at !== bt) return at < bt ? -1 : 1;
    return (a.id || 0) - (b.id || 0);
  });

  return manifest;
}

// True iff the manifest recorded at least one repaired/dropped ref. When it did,
// writing the manifest file is MANDATORY and we warn LOUDLY on stderr.
function manifestHasChanges(m) {
  return (
    m.recovered_commits.length +
    m.dropped_commits.length +
    m.dropped_session_entries.length +
    m.dropped_relates_to.length +
    m.dropped_corrects.length +
    m.dropped_promoted_log_id.length
  ) > 0;
}

// Emit the LOUD warning to stderr summarizing every repaired/dropped ref.
function warnRepairs(m) {
  console.error('pebbl migrate-to-events: --repair ALTERED the store to clear dangling FK refs:');
  for (const r of m.recovered_commits) {
    console.error(`  RECOVERED commit ${r.hash} (handoffs#${r.handoff}.session_commits[]) from git -> backfilled a commits row`);
  }
  for (const r of m.dropped_commits) {
    console.error(`  DROPPED dangling commit ${r.hash} from handoffs#${r.handoff}.session_commits[] (unrecoverable convenience back-link)`);
  }
  for (const r of m.dropped_session_entries) {
    console.error(`  DROPPED dangling log #${r.logId} from handoffs#${r.handoff}.session_entries[] (no surviving entry)`);
  }
  for (const r of m.dropped_relates_to) {
    console.error(`  CLEARED dangling logs#${r.logId}.relates_to -> ${r.target} (no surviving target)`);
  }
  for (const r of m.dropped_corrects) {
    console.error(`  CLEARED dangling logs#${r.logId}.corrects -> ${r.target} (row migrates as a plain append)`);
  }
  for (const r of m.dropped_promoted_log_id) {
    console.error(`  CLEARED dangling handoffs#${r.handoff}.promoted_log_id -> ${r.target} (no surviving target)`);
  }
  console.error(`  A manifest of every change was written to ${REPAIR_MANIFEST}.`);
}

// ── map-first pass: oldInt/hash -> ULID, all minted before any remap ──────────

// Build the COMPLETE identity maps before a single reference is rewritten, so
// no forward reference can dangle because a target was not minted yet
// (Acceptance #5). logs.id -> eid; commit hash -> eid. ULIDs are time-seeded
// from each row's timestamp; we read rows in (timestamp, id) order so minting
// order tracks legacy order. A per-row monotonic `emitted_at` (the fold's
// secondary key) guarantees the surviving fold order matches legacy order even
// when timestamps tie at the millisecond.
function buildIdMaps(snapshot) {
  const { logs, commits } = snapshot;
  const logEid = new Map();   // logs.id  -> eid
  const commitEid = new Map(); // commit hash -> eid

  // A single monotonic counter across BOTH tables, interleaved in time order,
  // so emitted_at is globally increasing and the (ts, emitted_at, eid) fold
  // order is total and matches legacy order. We encode the counter as an ISO
  // timestamp offset from a fixed epoch so it is a valid `emitted_at` string.
  const merged = [];
  for (const r of logs) merged.push({ kind: 'log', id: r.id, ts: r.timestamp });
  for (const c of commits) merged.push({ kind: 'commit', id: c.id, hash: c.hash, ts: c.timestamp });
  merged.sort((a, b) => {
    const at = a.ts || '';
    const bt = b.ts || '';
    if (at !== bt) return at < bt ? -1 : 1;
    // tie-break by (kind, legacy id) for a stable, reproducible mint order
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.id - b.id;
  });

  const emittedAt = new Map(); // "log:<id>" / "commit:<hash>" -> emitted_at iso
  const EPOCH = Date.parse('2000-01-01T00:00:00.000Z');
  merged.forEach((m, i) => {
    // monotonic, 1ms apart, so emitted_at strictly increases in mint order.
    const iso = new Date(EPOCH + i).toISOString();
    if (m.kind === 'log') {
      logEid.set(m.id, ulid(tsToMillis(m.ts)));
      emittedAt.set(`log:${m.id}`, iso);
    } else {
      commitEid.set(m.hash, ulid(tsToMillis(m.ts)));
      emittedAt.set(`commit:${m.hash}`, iso);
    }
  });

  return { logEid, commitEid, emittedAt };
}

// ── building the events (remap pass) ──────────────────────────────────────────

// Translate the snapshot into the ordered event list. Every FK is remapped
// through the COMPLETE maps from buildIdMaps. Field names match exactly what
// the P1 fold reads (fold.js): append/correct carry the log fields; correct
// carries `corrects` = the remapped target eid; commit -> a `commit` event;
// handoff-open carries session_entries (remapped logs eids) + session_commits
// (remapped commit eids) + promoted_log_id (remapped, stamped for losslessness
// though the current fold does not yet read it); handoff-close carries the open
// handoff's eid.
function buildEvents(snapshot, maps, actor) {
  const { logs, commits, handoffs } = snapshot;
  const { logEid, commitEid, emittedAt } = maps;
  const events = [];

  // logs -> append (or correct when logs.corrects is an explicit int). The 36
  // free-text 'correction'-category entries WITHOUT a corrects int stay plain
  // `append` (Q1=A, no heuristic).
  for (const row of logs) {
    const eid = logEid.get(row.id);
    const base = {
      eid,
      ts: row.timestamp,
      emitted_at: emittedAt.get(`log:${row.id}`),
      type: row.corrects != null ? 'correct' : 'append',
      actor,
      v: ENVELOPE_VERSION,
      source: row.source || 'human',
      category: row.category || 'uncategorized',
      tier: row.tier || 'detail',
      message: row.message || '',
      topics: row.topics || '',
      // valid_from is reproduced verbatim so plain appends keep db's value;
      // valid_to / invalidated_by are DERIVED by the fold from `correct`, never
      // re-emitted (see header note).
      valid_from: row.valid_from || row.timestamp,
      legacy_id: row.id, // old human refs ("see #412") still resolve (design IDs)
    };
    if (row.relates_to != null) base.relates_to = logEid.get(row.relates_to);
    if (row.corrects != null) base.corrects = logEid.get(row.corrects);
    events.push(base);
  }

  // commits table -> `commit` events. Separate id space from logs; the fold
  // reduces these into the commits projection (fold.js `commit` case), so a
  // rebuild-from-events regenerates the commits table + commit-log.md, and
  // session_commits remaps to their eids.
  for (const c of commits) {
    events.push({
      eid: commitEid.get(c.hash),
      ts: c.timestamp,
      emitted_at: emittedAt.get(`commit:${c.hash}`),
      type: 'commit',
      actor,
      v: ENVELOPE_VERSION,
      hash: c.hash,
      message: c.message || '',
      files: c.files || '',
    });
  }

  // handoffs -> handoff-open (+ handoff-close if closed). Mint one eid per
  // handoff; remap the two arrays per-element and promoted_log_id.
  let handoffEmitSeq = 0;
  const HANDOFF_EPOCH = Date.parse('2001-01-01T00:00:00.000Z');
  for (const h of handoffs) {
    const heid = ulid(tsToMillis(h.timestamp));
    const openEmitted = new Date(HANDOFF_EPOCH + handoffEmitSeq).toISOString();
    handoffEmitSeq += 1;

    const sessionEntries = parseJsonArray(h.session_entries, 'session_entries', h.id)
      .map((id) => logEid.get(id));
    const sessionCommits = parseJsonArray(h.session_commits, 'session_commits', h.id)
      .map((hash) => commitEid.get(hash));

    const open = {
      eid: heid,
      ts: h.timestamp,
      emitted_at: openEmitted,
      type: 'handoff-open',
      actor,
      v: ENVELOPE_VERSION,
      summary: h.summary || '',
      done: h.done || null,
      todo: h.todo || null,
      blocked: h.blocked || null,
      topics: h.topics || null,
      source: h.source || 'agent',
      session_entries: sessionEntries,
      session_commits: sessionCommits,
      docs: h.docs || null,
    };
    // promoted_log_id is a 6th relation in real stores; stamp it remapped so the
    // log stays lossless even though the current fold drops it (Friction).
    if (h.promoted_log_id != null) open.promoted_log_id = logEid.get(h.promoted_log_id);
    events.push(open);

    if (h.status === 'closed') {
      const closeEmitted = new Date(HANDOFF_EPOCH + handoffEmitSeq).toISOString();
      handoffEmitSeq += 1;
      events.push({
        eid: ulid(tsToMillis(h.closed_at || h.timestamp)),
        ts: h.closed_at || h.timestamp,
        emitted_at: closeEmitted,
        type: 'handoff-close',
        actor,
        v: ENVELOPE_VERSION,
        handoff: heid,
      });
    }
  }

  return events;
}

// ── idempotency ───────────────────────────────────────────────────────────────

// A store is "already migrated" iff db.sqlite has been renamed to
// legacy-db.sqlite — the migration-specific, irreversible marker. We do NOT key
// on events.jsonl alone: STAGING DRIFT means the P0 tracer (log.js, always on)
// writes an events.jsonl on every `pebbl log`, so a bare events.jsonl is the
// PARTIAL tracer log, not a completed migration. Keying on it would refuse to
// migrate every real store. legacy-db.sqlite present == db.sqlite renamed away
// == this migrator already ran (the contract's idempotency: no duplicate
// events, no re-rename). See Friction.
function alreadyMigrated(pebblDir) {
  return fs.existsSync(path.join(pebblDir, LEGACY_DB));
}

// ── plan rendering (dry-run) ──────────────────────────────────────────────────

function renderPlan(report, eventCount, apply) {
  const lines = [];
  lines.push('pebbl migrate-to-events — ' + (apply ? 'APPLY' : 'DRY-RUN (no changes written)'));
  lines.push('');
  lines.push('Audit (same snapshot):');
  lines.push(`  logs:                 ${report.logs}`);
  lines.push(`  commits:              ${report.commits}`);
  lines.push(`  handoffs:             ${report.handoffs}`);
  lines.push(`  logs.relates_to:      ${report.relatesTo} (resolved)`);
  lines.push(`  logs.corrects:        ${report.corrects} (-> correct events)`);
  lines.push(`  free-text corrections:${report.corrections} (-> plain append, Q1=A)`);
  lines.push(`  promoted_log_id:      ${report.promotedLogId} (resolved)`);
  lines.push(`  session_entries refs: ${report.sessionEntries} (per-element resolved)`);
  lines.push(`  session_commits refs: ${report.sessionCommits} (per-element resolved)`);
  lines.push('');
  lines.push('Plan:');
  lines.push(`  would write ${eventCount} events to events.jsonl`);
  lines.push('  would rename db.sqlite -> legacy-db.sqlite');
  if (!apply) {
    lines.push('');
    lines.push('Nothing was written. Re-run with --apply to migrate.');
  }
  return lines.join('\n');
}

// ── command entrypoint ────────────────────────────────────────────────────────

module.exports = function migrateToEvents(args = []) {
  const apply = wantsApply(args);
  const repair = wantsRepair(args);
  const pebblDir = requirePebblDir();

  // Idempotency: an already-migrated store is a safe no-op in BOTH modes (and a
  // second `--repair` run hits this same gate — nothing to repair, no-op).
  if (alreadyMigrated(pebblDir)) {
    console.log('pebbl migrate-to-events: store already migrated (events.jsonl / legacy-db.sqlite present) — no-op.');
    return;
  }

  const dbPath = path.join(pebblDir, 'db.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error('pebbl migrate-to-events: no db.sqlite to migrate.');
    process.exit(1);
  }
  // git-recovery needs the repo root (the parent of .pebbl).
  const repoRoot = path.dirname(path.resolve(pebblDir));

  // One read-only snapshot drives BOTH the audit and the build.
  const db = new Database(dbPath, { readonly: true });
  let snapshot;
  let report;
  let events;
  let manifest = null;
  try {
    snapshot = readSnapshot(db);
    if (repair) {
      // OPT-IN relaxation: deterministically clear dangling FK refs (git-recover
      // a commit, else drop the single ref) so the build pass sees a clean graph.
      // Mutates the snapshot in place and returns a manifest of every change. The
      // strict auditForeignKeys below then runs on the REPAIRED graph as a safety
      // net — if anything was missed it still aborts whole (no partial log).
      manifest = repairForeignKeys(snapshot, repoRoot);
    }
    // Audit — abort the whole store on ANY dangling reference, BEFORE any event
    // is built or written (no partial events.jsonl). STRICT is the DEFAULT; in
    // --repair this runs on the already-repaired snapshot and should pass clean.
    report = auditForeignKeys(snapshot);
    const maps = buildIdMaps(snapshot);            // map-first, all eids minted
    const actor = resolveActor(pebblDir);
    events = buildEvents(snapshot, maps, actor);   // remap pass
  } catch (err) {
    db.close();
    if (err instanceof MigrationAbort) {
      console.error(`pebbl migrate-to-events: ABORT — ${err.message}`);
      if (!repair) {
        console.error('Re-run with --repair to git-recover or drop dangling refs (writes a manifest).');
      }
      console.error('No events.jsonl written; db.sqlite untouched.');
      process.exit(1);
    }
    throw err;
  }
  db.close();

  const repaired = manifest && manifestHasChanges(manifest);

  if (!apply) {
    // Dry-run still SHOWS what --repair would change (loud), but writes nothing —
    // no manifest, no events. The actual manifest is written only on --apply.
    if (repaired) {
      warnRepairs(manifest);
      console.error('(dry-run: nothing written; re-run with --apply --repair to migrate.)');
    }
    console.log(renderPlan(report, events.length, false));
    return;
  }

  // Real run: serialize the whole write+rename under the per-store lock so a
  // concurrent local write can't interleave. The appender enforces the
  // trailing-newline invariant on every line (one event = one LF-terminated
  // line = one diff hunk).
  let movedTracer = false;
  withLock(pebblDir, () => {
    // Re-check inside the lock: another writer may have migrated while we built.
    if (alreadyMigrated(pebblDir)) {
      console.log('pebbl migrate-to-events: store already migrated (raced) — no-op.');
      return;
    }
    // Move the P0 tracer events.jsonl aside so the canonical migration log is
    // written fresh (not appended onto the tracer, which would double-count the
    // logs the tracer already wrote with throwaway eids). ADDITIVE — the tracer
    // is preserved as a .bak, never deleted.
    const evFile = eventsPath(pebblDir);
    if (fs.existsSync(evFile)) {
      fs.renameSync(evFile, path.join(pebblDir, TRACER_BAK));
      movedTracer = true;
    }
    for (const ev of events) {
      appendEvent(pebblDir, ev);
    }
    // ADDITIVE: never delete db.sqlite — rename to the rollback artifact.
    fs.renameSync(dbPath, path.join(pebblDir, LEGACY_DB));
    // ADDITIVE + atomic with the rename, under the same lock: write the positive
    // completeness marker so reads-from-fold engages even after compaction
    // re-creates db.sqlite, and so clones that pull the marker read from the
    // fold. (storeMode step 2 already covers stores migrated under OLD code with
    // no marker; this is the canonical signal for the migrated case.)
    fs.writeFileSync(
      path.join(pebblDir, EVENTS_CANONICAL_MARKER),
      'events.jsonl is the canonical store (written by migrate-to-events --apply)\n'
    );
    // MANDATORY whenever --repair altered/dropped anything: write the manifest so
    // the relaxation from strict is auditable. Written atomically with the
    // rename+marker under the same lock so a migrated store always carries the
    // record of what was repaired.
    if (repaired) {
      fs.writeFileSync(
        path.join(pebblDir, REPAIR_MANIFEST),
        JSON.stringify(
          { migrated_at: new Date().toISOString(), mode: 'repair', ...manifest },
          null, 2
        ) + '\n'
      );
    }
  });

  if (repaired) warnRepairs(manifest);
  console.log(renderPlan(report, events.length, true));
  console.log('');
  console.log(`Wrote ${events.length} events to events.jsonl; db.sqlite -> ${LEGACY_DB}.`);
  if (movedTracer) console.log(`Preserved the P0 tracer log as ${TRACER_BAK}.`);
  if (repaired) console.log(`Wrote a repair manifest to ${REPAIR_MANIFEST}.`);
};

// Exported for tests (pure pieces, no I/O): the audit, the map builder, the
// event builder, and the abort type.
module.exports.auditForeignKeys = auditForeignKeys;
module.exports.repairForeignKeys = repairForeignKeys;
module.exports.recoverCommitFromGit = recoverCommitFromGit;
module.exports.buildIdMaps = buildIdMaps;
module.exports.buildEvents = buildEvents;
module.exports.readSnapshot = readSnapshot;
module.exports.MigrationAbort = MigrationAbort;
module.exports.LEGACY_DB = LEGACY_DB;
module.exports.REPAIR_MANIFEST = REPAIR_MANIFEST;
