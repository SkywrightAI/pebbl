'use strict';
// P1 — the read-side emitters: take the folded projection (src/fold.js) and
// write the disposable `view.sqlite` rows plus the 4 markdown files, BYTE-
// IDENTICAL to what today's db.sqlite-driven generation produces. The string
// templates here are lifted verbatim from the canonical generators so the
// committed/regenerated markdown is the same on every machine:
//   - manual-logs.md  : regenerateMarkdown (compact.js:143-159)
//   - handoffs.md     : materializeHandoffsMd (handoff.js:248-272)
//   - narrative.md    : writeNarrative (narrative.js:19-25)
//   - commit-log.md   : logCommit (log-commit.js:24)
// Reusing the EXACT templates is the whole point — re-deriving them would let
// the fold drift from the db path and break the never-committed-markdown
// safety guarantee (design "The fold").
//
// This module READS the folded rows; it does not change how compaction WRITES
// (that is P3) and it does NOT rewire openDb or rename db.sqlite (that is the
// P2/P6 cutover). It writes a SEPARATE `view.sqlite` artifact so the fold-
// equivalence test can compare it against the live db.sqlite without touching
// the existing read path.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { foldFull } = require('./fold');
const { importanceForTier } = require('./rank');
// redact() is the projection-boundary secret mask. The DB/event log keeps the
// ORIGINAL text; only the COMMITTED .md these emitters write is sanitized, so a
// fake fixture key quoted in a note can't trip the factory promote gate's
// secret scan. It reuses privacy-scan's matcher (DRY: one leak-shape
// definition) and is deterministic, so re-projecting the same rows is
// byte-identical. NOTE: the view.sqlite row writer below is intentionally NOT
// masked — that file is gitignored/disposable (rebuilt from events), never
// committed, so masking it would diverge the read model from the source of
// truth. Only the .md strings are sanitized.
const { redact } = require('./privacy-scan');

// ── markdown emitters (byte-identical tails) ─────────────────────────────────

// manual-logs.md. regenerateMarkdown selects ALL logs ORDER BY timestamp ASC
// (no valid_to filter — corrected rows STAY in the markdown; only the live
// VIEW hides them). topicStr is `row.topics || ''`, source is the row source.
function renderManualLogsMd(logs) {
  const ordered = logs.slice().sort(byTimestampAscStable);
  let md = '# Manual Logs\n\n';
  for (const row of ordered) {
    const topicStr = row.topics || '';
    md += `## ${row.timestamp} - ${redact(row.message)}\n`;
    md += `<!-- cat:${row.category} topic:${topicStr} tier:${row.tier} source:${row.source} -->\n\n`;
  }
  return md;
}

// handoffs.md. materializeHandoffsMd orders handoffs by id ASC, emits a
// summary block + one block per ';'-split done/todo/blocked item, joined by
// '\n'. ts = closed_at || timestamp. Verbatim from handoff.js:248-272.
const { splitItems } = require('./items');
function renderHandoffsMd(handoffs) {
  const ordered = handoffs.slice().sort((a, b) => a.id - b.id);
  const out = ['# Handoffs', ''];
  for (const row of ordered) {
    const ts = row.closed_at || row.timestamp;
    const topic = row.topics || '';
    const status = row.status || 'open';
    const blocks = [['summary', `handoff #${row.id}: ${redact(row.summary)}`]];
    for (const field of ['done', 'todo', 'blocked']) {
      for (const item of splitItems(row[field])) {
        blocks.push([field, `handoff #${row.id} ${field}: ${redact(item)}`]);
      }
    }
    for (const [field, message] of blocks) {
      out.push(`## ${ts} - ${message}`);
      out.push(`<!-- handoff:${row.id} field:${field} topic:${topic} status:${status} -->`);
      out.push('');
    }
  }
  return out.join('\n');
}

// narrative.md. writeNarrative format, verbatim from narrative.js:19-25. The
// folded narrative carries the LATEST narrative-set's text/refs/updated; the
// `<!-- updated: ts -->` uses that event's ts (not Date.now()) so the file is
// deterministic across machines. Returns '' when no narrative was ever set.
function renderNarrativeMd(narrative) {
  if (!narrative) return '';
  const refs = narrative.refs || [];
  const refsLine = refs.length > 0 ? `<!-- refs: ${refs.join(',')} -->\n` : '';
  return `# Project Narrative\n\n${redact((narrative.text || '').trim())}\n\n${refsLine}<!-- updated: ${narrative.updated} -->\n`;
}

// commit-log.md. logCommit APPENDS per commit; we render the whole file from
// the folded commit rows in order. Verbatim block from log-commit.js:24.
function renderCommitLogMd(commits) {
  let md = '';
  for (const c of commits) {
    const shortHash = (c.hash || 'unknown').slice(0, 8);
    const msg = redact((c.message || '').trim().split('\n')[0]);
    const category = c.category || 'uncategorized';
    const tier = c.tier || 'fleeting';
    const fileList = (c.files || '').replace(/,$/, '');
    md += `## ${c.timestamp} - ${shortHash}: ${msg}\n`;
    md += `<!-- cat:${category} topic: tier:${tier} source:hook -->\n\n`;
    md += `Files: ${fileList || '(none)'}\n\n`;
  }
  return md;
}

// Stable timestamp-ASC sort. logs already arrive in (ts,emitted_at,eid) order
// from the fold, so a stable sort on timestamp preserves that tie-break — the
// same order db.sqlite's `ORDER BY timestamp ASC` yields for same-ts rows is
// insertion order, which the fold's deterministic order reproduces.
function byTimestampAscStable(a, b) {
  const at = a.timestamp || '';
  const bt = b.timestamp || '';
  if (at < bt) return -1;
  if (at > bt) return 1;
  return a.id - b.id; // stable tie-break by the assigned local int
}

// ── view.sqlite row writer ───────────────────────────────────────────────────
//
// Build a disposable view.sqlite with the SAME logs/handoffs/commits schema
// db.sqlite uses, populated from the folded rows. INTEGER ids/corrects/
// relates_to come straight from the eid->int map (FK translation), so the
// read-side subqueries (`valid_to IS NULL`, `id NOT IN (...)`, `b.id - a.id`)
// behave identically off this view. Returns the file path.
// The view's `logs` table must present the SAME read contract the read path
// (context.js / search.js) expects off db.sqlite AFTER the v0.6/v0.7 migrations:
// the rerank signal columns `importance` / `access_count` / `last_accessed` are
// SELECTed by context's queries (and by rank.js's score), so the view carries
// them too or those reads throw "no such column". They are NOT in the events
// envelope (guardrail: don't change the envelope) — usage is a LOCAL runtime
// signal — so the fold supplies importance tier-derived (importanceForTier, the
// same source of truth log.js + the v0.6/v0.7 migration use, DRY) and leaves
// access_count/last_accessed at their column defaults (0 / NULL). A freshly
// folded view from a teammate's events therefore reads exactly like a fresh,
// zero-usage db.sqlite at v0.7 — which is correct: usage accrues per machine.
const VIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY,
  timestamp  TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'human',
  category   TEXT    NOT NULL DEFAULT 'uncategorized',
  tier       TEXT    NOT NULL DEFAULT 'detail',
  message    TEXT    NOT NULL,
  topics     TEXT,
  relates_to INTEGER,
  corrects   INTEGER,
  valid_from TEXT,
  valid_to   TEXT,
  invalidated_by INTEGER,
  importance REAL DEFAULT 0,
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS commits (
  id        INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,
  hash      TEXT NOT NULL,
  message   TEXT NOT NULL,
  files     TEXT
);
CREATE TABLE IF NOT EXISTS handoffs (
  id               INTEGER PRIMARY KEY,
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
`;

function writeViewSqlite(projection, viewPath) {
  // Fresh file every rebuild — the view is disposable.
  try { fs.unlinkSync(viewPath); } catch { /* not present, fine */ }
  const db = new Database(viewPath);
  try {
    db.exec(VIEW_SCHEMA);
    // access_count / last_accessed are intentionally omitted so the column
    // DEFAULTs (0 / NULL) apply — usage is a per-machine runtime signal, not
    // folded from the shared events. importance IS written, tier-derived.
    const insLog = db.prepare(`
      INSERT INTO logs (id, timestamp, source, category, tier, message, topics,
                        relates_to, corrects, valid_from, valid_to, invalidated_by,
                        importance)
      VALUES (@id, @timestamp, @source, @category, @tier, @message, @topics,
              @relates_to, @corrects, @valid_from, @valid_to, @invalidated_by,
              @importance)
    `);
    const insHandoff = db.prepare(`
      INSERT INTO handoffs (id, timestamp, summary, done, todo, blocked, topics,
                            source, session_entries, session_commits, status, closed_at, docs)
      VALUES (@id, @timestamp, @summary, @done, @todo, @blocked, @topics,
              @source, @session_entries, @session_commits, @status, @closed_at, @docs)
    `);
    const insCommit = db.prepare(`
      INSERT INTO commits (id, timestamp, hash, message, files)
      VALUES (@id, @timestamp, @hash, @message, @files)
    `);
    const tx = db.transaction(() => {
      for (const r of projection.logs) {
        insLog.run({
          id: r.id,
          timestamp: r.timestamp,
          source: r.source,
          category: r.category,
          tier: r.tier,
          message: r.message,
          topics: r.topics || null,
          relates_to: r.relates_to,
          corrects: r.corrects,
          valid_from: r.valid_from || r.timestamp,
          valid_to: r.valid_to,
          invalidated_by: r.invalidated_by,
          // Tier-derived default (importanceForTier — same mapping log.js and
          // the v0.7 migration use), unless the folded row already carries an
          // explicit importance. Keeps rerank tier-aware on a freshly folded
          // view even though access_count starts at 0.
          importance: (r.importance != null && r.importance !== 0)
            ? r.importance
            : importanceForTier(r.tier),
        });
      }
      for (const h of projection.handoffs) {
        insHandoff.run({
          id: h.id,
          timestamp: h.timestamp,
          summary: h.summary,
          done: h.done,
          todo: h.todo,
          blocked: h.blocked,
          topics: h.topics,
          source: h.source,
          session_entries: JSON.stringify(h.session_entries || []),
          session_commits: JSON.stringify(h.session_commits || []),
          status: h.status,
          closed_at: h.closed_at,
          docs: h.docs,
        });
      }
      for (const c of projection.commits) {
        insCommit.run({
          id: c.id,
          timestamp: c.timestamp,
          hash: c.hash,
          message: c.message,
          files: c.files || null,
        });
      }
    });
    tx();
    // Build the disposable FTS5 search index in the SAME seam that writes the
    // view rows, so a freshly-folded view.sqlite (events-mode read path) and the
    // rebuilt db.sqlite (compact.rebuildReadModelFromEvents) both ship a current
    // index — no separate lifecycle, no new file (it rides inside this DB, which
    // is already gitignored). External-content over the `logs` rows just inserted
    // above; rebuildable from events.jsonl because those rows came from the fold.
    // Lazy require breaks the view.js <-> db.js (-> staleness -> view) cycle.
    // Best-effort: FTS is derived — a build failure must not break the fold.
    try {
      require('./db').buildFtsIndex(db);
    } catch { /* FTS is disposable; search falls back to LIKE if it's absent */ }
  } finally {
    db.close();
  }
  return viewPath;
}

// ── top-level rebuild: events -> view.sqlite + 4 markdown files ──────────────
//
// The target the P0 `rebuild(rows)` seam (events.js:appendLogEvent) is meant
// to fill in. Pure-ish: writes files under pebblDir, returns the projection.
// view.sqlite is written as `view.sqlite` (NOT db.sqlite) so the existing read
// path P2 migrates is untouched (Guardrail: P1 may write a view.sqlite artifact
// but must not rewire openDb or rename db.sqlite).
function rebuildView(pebblDir, events) {
  const projection = foldFull(events);
  fs.writeFileSync(path.join(pebblDir, 'manual-logs.md'), renderManualLogsMd(projection.logs));
  fs.writeFileSync(path.join(pebblDir, 'handoffs.md'), renderHandoffsMd(projection.handoffs));
  const narrativeMd = renderNarrativeMd(projection.narrative);
  if (narrativeMd) {
    fs.writeFileSync(path.join(pebblDir, 'narrative.md'), narrativeMd);
  }
  fs.writeFileSync(path.join(pebblDir, 'commit-log.md'), renderCommitLogMd(projection.commits));
  writeViewSqlite(projection, path.join(pebblDir, 'view.sqlite'));
  return projection;
}

module.exports = {
  renderManualLogsMd,
  renderHandoffsMd,
  renderNarrativeMd,
  renderCommitLogMd,
  writeViewSqlite,
  rebuildView,
  splitItems,
};
