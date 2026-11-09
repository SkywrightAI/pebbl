'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { migrate } = require('./migrate');
const { storeMode } = require('./store-mode');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'human',
  category   TEXT    NOT NULL DEFAULT 'uncategorized',
  tier       TEXT    NOT NULL DEFAULT 'detail',
  message    TEXT    NOT NULL,
  topics     TEXT,
  relates_to INTEGER,
  corrects   INTEGER,
  valid_from TEXT,           -- when this belief started being true (defaults to timestamp)
  valid_to   TEXT,           -- when it stopped being true; NULL = currently believed
  invalidated_by INTEGER     -- the entry that superseded it
);
CREATE TABLE IF NOT EXISTS commits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  hash      TEXT NOT NULL,
  message   TEXT NOT NULL,
  files     TEXT
);
CREATE TABLE IF NOT EXISTS handoffs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp        TEXT    NOT NULL,
  summary          TEXT    NOT NULL,
  done             TEXT,
  todo             TEXT,
  blocked          TEXT,
  topics           TEXT,
  source           TEXT    NOT NULL DEFAULT 'agent',
  session_entries  TEXT,
  session_commits  TEXT,
  status           TEXT    NOT NULL DEFAULT 'open',
  closed_at        TEXT,
  promoted_log_id  INTEGER,
  docs             TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0.3');
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
CREATE INDEX IF NOT EXISTS idx_logs_tier ON logs(tier);
CREATE INDEX IF NOT EXISTS idx_logs_valid_to ON logs(valid_to);
`;

function openDb(pebblDir) {
  // P4 — lazy staleness on the read path. Before handing back a handle, bring
  // view.sqlite + the 4 markdown files up to date with events.jsonl if a
  // post-merge/post-checkout (or a concurrent append on another machine) added
  // lines since the last fold. This is what makes "new view rows surface after
  // an append with NO manual rebuild" true on the very next command, and what
  // lets the git hooks stay lazy (they only touch a sentinel; the fold happens
  // here on the next read). Cheap when already fresh (a fingerprint compare, no
  // fold) and a no-op when this process already holds the store lock (we're
  // mid-write — see staleness.ensureFresh's re-entrancy guard). Best-effort: a
  // staleness failure must never break opening db.sqlite (the canonical store).
  try {
    require('./staleness').ensureFresh(pebblDir);
  } catch {
    // never let the lazy fold break the canonical read path
  }
  const db = new Database(path.join(pebblDir, 'db.sqlite'));
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);
  return db;
}

// Wire 2 — reads-from-fold. THE read-path entry point for the curated views
// (context.js / search.js). It picks WHERE a read is served FROM:
//
//   events-mode (events.jsonl present, storeMode()==='events')
//     -> serve from the FOLDED view.sqlite. This is the whole point of shared
//        memory: a teammate who pulls only the committed events.jsonl (db.sqlite
//        is gitignored, so they don't get yours) must still SEE the merged
//        learnings. ensureFresh() folds events.jsonl -> view.sqlite first (the
//        same lazy fold openDb already runs), so a just-merged events.jsonl is
//        materialized before we open the view. The view is opened READONLY: it's
//        a derived projection, never written through this handle.
//
//   legacy-mode (no events.jsonl) -> db.sqlite, byte-for-byte the old read path
//     (this just delegates to openDb, so legacy behavior is UNCHANGED — the
//     Acceptance #5 coexistence guarantee).
//
// FALLBACK: if anything about the view is unusable (fold skipped because this
// process holds the write lock, view.sqlite missing/corrupt, a fold error),
// fall back to openDb(db.sqlite). The canonical store is always a safe read, so
// a view glitch degrades to "reads from db.sqlite" rather than throwing. On a
// pure-pull clone with no db.sqlite that fallback would be an empty store, but
// ensureFresh builds the view from the pulled events.jsonl in that exact case,
// so the common shared-pull path serves from the fold as intended.
//
// The handle is a plain better-sqlite3 Database on view.sqlite. It deliberately
// does NOT run migrate(): view.sqlite is disposable and rebuilt by the fold
// (src/view.js VIEW_SCHEMA), which already presents the post-v0.7 read contract
// (the rerank columns). Running the canonical migrator on it would be wrong
// (it's not the canonical store and has no AUTOINCREMENT/version row to evolve).
function openReadDb(pebblDir) {
  if (storeMode(pebblDir) !== 'events') {
    // Legacy store: the existing canonical read path, unchanged.
    return openDb(pebblDir);
  }
  // Events store: fold events.jsonl -> view.sqlite (lazy, cheap when fresh),
  // then read from the view. Best-effort, mirroring openDb's staleness guard —
  // never let a fold failure break opening a read handle.
  try {
    require('./staleness').ensureFresh(pebblDir);
  } catch {
    // fall through; we'll try to open whatever view exists, else db.sqlite
  }
  const viewFile = path.join(pebblDir, 'view.sqlite');
  if (fs.existsSync(viewFile)) {
    try {
      // readonly: the view is a projection; reads never write through it. (The
      // usage-signal write recordAccess targets the CANONICAL db on the targeted
      // lookup path, not this read handle — see context.js contextTopic.)
      return new Database(viewFile, { readonly: true, fileMustExist: true });
    } catch {
      // corrupt/locked view -> fall back to the canonical store below.
    }
  }
  return openDb(pebblDir);
}

// The db.sqlite row for a handoff the READ side returned, found by (timestamp,
// summary), never by id. In an events-mode store the read view's integer id is
// a per-rebuild artifact of the fold that can name a DIFFERENT db.sqlite row
// (loom: view #1 was a 2026-07 handoff, db #1 the one written on 2026-11-09),
// and neither table carries the event's eid — but a handoff's timestamp and
// summary are written identically to its db row and its handoff-open event, so
// together they identify it. Only an OPEN row is returned: the caller is
// closing it, and a row already closed here has nothing left to update.
// undefined when this db.sqlite never held the handoff (written on another
// clone, or before this db.sqlite existed).
function openHandoffRowByKey(db, { timestamp, summary }) {
  return db.prepare(
    "SELECT * FROM handoffs WHERE timestamp = ? AND summary = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
  ).get(timestamp, summary);
}

module.exports = { openDb, openReadDb, openHandoffRowByKey };

// ── FTS5 full-text search index (M1) ─────────────────────────────────────────
//
// pebbl search rides SQLite's built-in FTS5 + bm25() (compiled into the bundled
// better-sqlite3 — PRAGMA compile_options shows ENABLE_FTS5; no extension load,
// no new dependency). The index is an EXTERNAL-CONTENT virtual table over the
// `logs` table (content='logs', content_rowid='id'): FTS5 stores only the
// inverted index, not a second copy of the message text — the text stays in
// `logs`, and a query joins back by rowid==logs.id. The table lives INSIDE the
// same SQLite file the read path opens (view.sqlite in events-mode, db.sqlite in
// legacy-mode), so it inherits view.sqlite/db.sqlite's DERIVED/DISPOSABLE status
// and its existing .gitignore line — there is NO new file to ignore.
//
// The `porter` tokenizer gives stemming (a query for `reject` matches a stored
// `rejected`); bm25() is FTS5's default relevance rank. The index is rebuilt
// from `logs` content (`INSERT INTO fts(fts) VALUES('rebuild')`) rather than
// kept in sync by triggers: it is built in the SAME seam that writes the view
// rows (view.js writeViewSqlite), and refreshed on the legacy read path before a
// search, so it is always derivable from the canonical rows and reproduces the
// same ranking on any machine. Rebuild is milliseconds even at thousands of rows
// (a curated pebbl store is far smaller).
const FTS_TABLE = 'logs_fts';

// Is FTS5 compiled into this SQLite build? A pure capability probe — does NOT
// require the index table to exist. Cheap (reads the cached compile options).
// Best-effort: any failure (older/odd build) is treated as "no FTS5" so the
// caller degrades to the LIKE fallback rather than throwing.
function fts5Compiled(db) {
  try {
    return db
      .prepare('PRAGMA compile_options')
      .all()
      .some((r) => r.compile_options === 'ENABLE_FTS5');
  } catch {
    return false;
  }
}

// Does the FTS index table exist in this database? (sqlite_master lists the
// virtual table by name.) Used to decide whether a readonly view.sqlite already
// carries the index writeViewSqlite built, vs needing a lazy build.
function ftsTableExists(db) {
  try {
    return !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(FTS_TABLE);
  } catch {
    return false;
  }
}

// Create (if absent) the external-content FTS5 table over `logs` and (re)build
// its content from the current `logs` rows. Idempotent and cheap. Requires a
// WRITABLE handle (the legacy db.sqlite read path and the view writer both have
// one); a readonly view.sqlite never calls this — writeViewSqlite already built
// its index. Returns true on success, false if FTS5 is unavailable or the build
// failed (caller then falls back to the LIKE search).
function buildFtsIndex(db) {
  if (db.readonly) return false; // can't build on a readonly view handle
  if (!fts5Compiled(db)) return false;
  try {
    // External-content table: indexes logs.message keyed by logs.id, storing no
    // duplicate text. `porter` => stemming. "using fts5" appears here as the
    // single source of the virtual-table DDL.
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} ` +
        `USING fts5(message, content='logs', content_rowid='id', tokenize='porter')`
    );
    // Rebuild from content: drops any stale postings and reindexes every current
    // logs row. Deterministic — same rows in, same index out — which is what
    // makes `ORDER BY bm25(fts), id` reproduce across git-synced machines.
    db.exec(`INSERT INTO ${FTS_TABLE}(${FTS_TABLE}) VALUES('rebuild')`);
    return true;
  } catch {
    // A virtual-table create/rebuild failure must never break search; the caller
    // degrades to the LIKE fallback.
    return false;
  }
}

// Capability probe for the SEARCH READ PATH: is FTS5 usable against `db` right
// now? True when FTS5 is compiled AND either the index table is already present
// (a freshly-folded view.sqlite) or we can build it on this writable handle
// (legacy db.sqlite). Used at search.js's branch to gate the FTS read path. On
// a readonly handle with no table it returns false, so search degrades to the
// LIKE fallback instead of throwing.
function fts5Available(db) {
  if (!fts5Compiled(db)) return false;
  if (ftsTableExists(db)) return true;
  return !db.readonly; // writable -> searchFts5 will build it on demand
}

module.exports.FTS_TABLE = FTS_TABLE;
module.exports.fts5Compiled = fts5Compiled;
module.exports.ftsTableExists = ftsTableExists;
module.exports.buildFtsIndex = buildFtsIndex;
module.exports.fts5Available = fts5Available;

function topicFilter(topic) {
  return {
    clause: "AND (',' || topics || ',' LIKE ? OR topics = ? OR topics LIKE ? || ',' OR topics LIKE ',' || ?)",
    params: [`%,${topic},%`, topic, topic, topic],
  };
}

module.exports.topicFilter = topicFilter;

// Single source of truth for "this entry is the current belief" — i.e. it has
// not been superseded by a correction. As of v0.5 (bi-temporal supersession)
// this is the stamped predicate `valid_to IS NULL`, replacing the old
// `id NOT IN (SELECT corrects ...)` subquery that HID the corrected row and
// lost the timeline. Centralizing it keeps every read site using one
// definition so they cannot drift (DRY). Returns a parameter-free SQL fragment;
// prefix with AND/WHERE as needed.
function notCorrected() {
  return 'valid_to IS NULL';
}

// Beliefs valid AT a given date (bi-temporal point-in-time query): a row was
// believed if it had started (valid_from <= date) and had not yet stopped
// (valid_to is still open, or stopped strictly after the date). Returns a
// fragment with two '?' placeholders; bind the same date twice.
function validAsOf() {
  return 'valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)';
}

module.exports.notCorrected = notCorrected;
module.exports.validAsOf = validAsOf;

// ── rerank usage signal: increment-on-INTENTIONAL-LOOKUP (v0.7, FIX 1) ─────────
//
// When the user INTENTIONALLY looks an entry up, bump its access_count and stamp
// last_accessed=now. access_count is the runtime signal rank.js's usage term
// reads, so the usage win accrues from real lookups rather than staying flat.
//
// SCOPE — only the TARGETED retrieval path calls this (FIX 1):
//   - context.js contextTopic: `pebbl context --topic <x>`. This is the user
//     asking "what do we know about X" and getting that topic's entries — a
//     genuine retrieval. It calls recordAccess on exactly the ids it returned.
//   - contextDefault (the plain `pebbl context` dump, capped or --full) and
//     contextFull (the cat/tier/source-filtered flat dump) DELIBERATELY
//     do NOT call this. They are broad session-start renders; counting the rows
//     they PRINT would make access_count track print-frequency, a rich-get-richer
//     loop that pollutes the usage signal. rerank still ORDERS those reads by
//     current usage (that does not inflate it) — only the WRITE is gated.
//   - contextAsOf is excluded: a bitemporal time-travel view of historical
//     (possibly superseded) beliefs, not a current-belief lookup.
//   - There is currently NO single-entry `show` command (the only `--show` flag is
//     narrative's). If one is ever added it should call recordAccess (it is the
//     archetypal intentional lookup).
//   - search.js is a FOLLOW-UP, intentionally untouched: its SQLite path does not
//     select id, so there is nothing to increment without a separate change.
//     Wiring search-result increments is the next slice.
// It must NOT fire on internal/programmatic reads (drift checks, topic-index
// COUNT aggregates, narrative refs, compaction previews).
//
// last_accessed: written here (when an entry was last looked up) but NOT YET read
// by any ranking code — recency is a TIEBREAK on `timestamp`, not on last_accessed
// (see rank.js). It is RESERVED for a future recency-of-ACCESS signal (e.g. decay
// usage by how long since the last lookup). Stamped now so that signal has real
// history to work from when it lands; it is not a dead write pretending to rank.
//
// DETERMINISM GUARD — never increment during the test suite. node's test runner
// sets NODE_TEST_CONTEXT in every test file process, so a guard on it keeps the
// suite's access_count stable across runs (Gate 4) without each test opting out.
// The CLI runs without that env var, so production lookups still count. Tests that
// need to exercise the write path clear NODE_TEST_CONTEXT around the call (see
// test/recordAccess.test.js) — there is no force flag.
//
// CONCURRENCY / PERF — a write-on-read: one lookup can issue several cheap UPDATEs.
// Each id is a single indexed UPDATE by primary key, deduped per call so an entry
// shown twice counts once. better-sqlite3 is synchronous; a failure here must
// never break the read, so the whole thing is best-effort/try-caught.
function shouldCountAccess() {
  // The test runner sets this; absence means a real CLI invocation.
  return !process.env.NODE_TEST_CONTEXT;
}

function recordAccess(db, ids, opts = {}) {
  if (!shouldCountAccess()) return;
  const unique = [...new Set((ids || []).filter(id => id != null))];
  if (unique.length === 0) return;
  const now = opts.now || new Date().toISOString();
  try {
    const stmt = db.prepare(
      'UPDATE logs SET access_count = access_count + 1, last_accessed = ? WHERE id = ?'
    );
    const tx = db.transaction((rows) => {
      for (const id of rows) stmt.run(now, id);
    });
    tx(unique);
  } catch {
    // Never let a usage-signal write break the read path it rode in on.
  }
}

module.exports.recordAccess = recordAccess;
module.exports.shouldCountAccess = shouldCountAccess;
