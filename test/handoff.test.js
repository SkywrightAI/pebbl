'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');
const Database = require('better-sqlite3');
const { splitItems, joinField, materializeHandoffsMd, malformedSummary } = require('../src/handoff');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');

// A real, init'd pebbl project in a git repo so `pebbl handoff` finds .pebbl and
// the create path (auto-collect git log) doesn't error. Returns the project dir.
function initProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-handoff-e2e-'));
  execSync('git init -q', { cwd: dir });
  spawnSync(BIN, ['init'], { cwd: dir, encoding: 'utf8' });
  return dir;
}

function runHandoff(dir, args) {
  return spawnSync(BIN, ['handoff', ...args], { cwd: dir, encoding: 'utf8' });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-test-'));
}

function setupDb(dir) {
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  TEXT    NOT NULL,
      source     TEXT    NOT NULL DEFAULT 'human',
      category   TEXT    NOT NULL DEFAULT 'uncategorized',
      tier       TEXT    NOT NULL DEFAULT 'detail',
      message    TEXT    NOT NULL,
      topics     TEXT,
      relates_to INTEGER,
      corrects   INTEGER
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
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0.4');
  `);
  return db;
}

describe('handoff - detail-doc guard', () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function project() {
    const d = initProject();
    dirs.push(d);
    return d;
  }
  function handoffCount(dir) {
    const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'));
    const n = db.prepare('SELECT COUNT(*) c FROM handoffs').get().c;
    db.close();
    return n;
  }
  // > DETAIL_DOC_THRESHOLD (1200 chars of done+todo+blocked) while inside the item
  // caps (8 items, 160 chars each): 8 x 154 chars = ~1246.
  const heavy = Array.from({ length: 8 }, (_, i) => `item ${i} ` + 'detail '.repeat(21)).join('; ');

  it('REFUSES a detail-heavy handoff with neither --docs nor --no-doc, store untouched', () => {
    const d = project();
    const r = runHandoff(d, ['heavy session', '--done', heavy]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no rendered doc/i);
    assert.equal(handoffCount(d), 0, 'refused BEFORE the insert — no row written');
  });

  it('PASSES when a rendered doc is linked with --docs', () => {
    const d = project();
    const r = runHandoff(d, ['heavy session', '--done', heavy, '--docs', 'docs/handoffs/x.md']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Handoff #\d+ created/);
    assert.equal(handoffCount(d), 1);
  });

  it('PASSES with the explicit --no-doc opt-out (no truncation forced)', () => {
    const d = project();
    const r = runHandoff(d, ['heavy session', '--done', heavy, '--no-doc']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(handoffCount(d), 1);
  });

  it('does NOT fire on a normal, light handoff', () => {
    const d = project();
    const r = runHandoff(d, ['light session', '--done', 'shipped X; fixed Y', '--todo', 'wire Z']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(handoffCount(d), 1);
  });

  it('resurfaces the linked doc on `pebbl context`', () => {
    const d = project();
    runHandoff(d, ['heavy session', '--done', heavy, '--docs', 'docs/handoffs/x.md']);
    const ctx = spawnSync(BIN, ['context'], { cwd: d, encoding: 'utf8' });
    assert.match(ctx.stdout, /docs\/handoffs\/x\.md/, 'the doc path is shown on pickup');
  });
});

describe('handoff - create', () => {
  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inserts a handoff with all fields', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const ts = '2026-05-25T10:00:00.000Z';
    db.prepare(`
      INSERT INTO handoffs (timestamp, summary, done, todo, blocked, topics, source, session_entries, session_commits, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ts, 'test summary', 'task A; task B', 'task C', 'waiting on review', 'auth,db', 'human', '[]', '[]', 'open');

    const row = db.prepare('SELECT * FROM handoffs WHERE id = 1').get();

    assert(row);
    assert.strictEqual(row.summary, 'test summary');
    assert.strictEqual(row.done, 'task A; task B');
    assert.strictEqual(row.todo, 'task C');
    assert.strictEqual(row.blocked, 'waiting on review');
    assert.strictEqual(row.topics, 'auth,db');
    assert.strictEqual(row.source, 'human');
    assert.strictEqual(row.session_entries, '[]');
    assert.strictEqual(row.session_commits, '[]');
    assert.strictEqual(row.status, 'open');
    assert.strictEqual(row.timestamp, ts);
  });

  it('auto-collects session entries since last handoff', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insertLog = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );

    // Insert logs before the previous handoff (should NOT be collected)
    insertLog.run('2026-05-24T10:00:00.000Z', 'human', 'decision', 'detail', 'old entry 1', 'auth');
    insertLog.run('2026-05-24T11:00:00.000Z', 'human', 'decision', 'detail', 'old entry 2', 'auth');

    // Insert a previous handoff with timestamp 2026-05-24T12:00:00Z
    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    ).run('2026-05-24T12:00:00.000Z', 'previous handoff', 'closed');

    // Insert logs after the previous handoff (SHOULD be collected)
    insertLog.run('2026-05-25T08:00:00.000Z', 'human', 'decision', 'detail', 'new entry 1', 'auth');
    insertLog.run('2026-05-25T09:00:00.000Z', 'human', 'decision', 'detail', 'new entry 2', 'db');

    // Simulate auto-collect: find logs since last handoff
    const lastHandoff = db.prepare('SELECT timestamp FROM handoffs ORDER BY id DESC LIMIT 1').get();
    const cutoff = lastHandoff.timestamp;
    const sessionLogs = db.prepare('SELECT id FROM logs WHERE timestamp > ?').all(cutoff);
    const sessionEntries = sessionLogs.map(r => r.id);

    assert.strictEqual(sessionEntries.length, 2);
    // IDs 1 and 2 were before cutoff; IDs 3 and 4 are after
    assert(sessionEntries.includes(3));
    assert(sessionEntries.includes(4));
  });

  it('defaults status to open', () => {
    dir = tmpDir();
    db = setupDb(dir);

    db.prepare(
      'INSERT INTO handoffs (timestamp, summary) VALUES (?, ?)'
    ).run('2026-05-25T12:00:00.000Z', 'new handoff');

    const row = db.prepare('SELECT * FROM handoffs WHERE id = 1').get();

    assert(row);
    assert.strictEqual(row.status, 'open');
    assert.strictEqual(row.closed_at, null);
  });
});

describe('handoff - close', () => {
  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT flatten handoff fields into a foundation log row', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const ts = '2026-05-25T10:00:00.000Z';
    db.prepare(`
      INSERT INTO handoffs (timestamp, summary, done, todo, blocked, topics, source, session_entries, session_commits, status, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'closed', ?)
    `).run(ts, 'completed auth module', 'implemented JWT; added tests', 'write docs', 'CI pipeline', 'auth,security', 'agent', '[]', '[]', '2026-05-25T18:00:00.000Z');

    // New close behavior: materialize to handoffs.md, never promote to logs.
    materializeHandoffsMd(dir, db);

    const logCount = db.prepare('SELECT COUNT(*) AS c FROM logs').get();
    assert.strictEqual(logCount.c, 0, 'close must not create any log rows');
  });

  it('materializes each ;-split item as its own searchable block', () => {
    dir = tmpDir();
    db = setupDb(dir);

    db.prepare(`
      INSERT INTO handoffs (timestamp, summary, done, todo, blocked, topics, status, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'closed', ?)
    `).run('2026-05-25T10:00:00.000Z', 'completed auth module', 'implemented JWT; added tests', 'write docs', 'CI pipeline', 'auth,security', '2026-05-25T18:00:00.000Z');

    materializeHandoffsMd(dir, db);
    const md = fs.readFileSync(path.join(dir, 'handoffs.md'), 'utf8');

    // One block per item — two done items, one todo, one blocked, plus summary.
    assert.match(md, /## .+ - handoff #1: completed auth module/);
    assert.match(md, /## .+ - handoff #1 done: implemented JWT\n<!-- handoff:1 field:done topic:auth,security status:closed -->/);
    assert.match(md, /## .+ - handoff #1 done: added tests\n<!-- handoff:1 field:done topic:auth,security status:closed -->/);
    assert.match(md, /## .+ - handoff #1 todo: write docs\n<!-- handoff:1 field:todo topic:auth,security status:closed -->/);
    assert.match(md, /## .+ - handoff #1 blocked: CI pipeline\n<!-- handoff:1 field:blocked topic:auth,security status:closed -->/);
  });

  it('materializes both open and closed handoffs with a status tag', () => {
    dir = tmpDir();
    db = setupDb(dir);

    db.prepare("INSERT INTO handoffs (timestamp, summary, done, status, closed_at) VALUES (?,?,?,?,?)")
      .run('2026-05-25T10:00:00.000Z', 'closed one', 'did a thing', 'closed', '2026-05-25T11:00:00.000Z');
    db.prepare("INSERT INTO handoffs (timestamp, summary, done, status) VALUES (?,?,?,?)")
      .run('2026-05-26T10:00:00.000Z', 'open one', 'in-progress work', 'open');

    materializeHandoffsMd(dir, db);
    const md = fs.readFileSync(path.join(dir, 'handoffs.md'), 'utf8');

    assert.match(md, /closed one/);
    assert.match(md, /open one/);
    assert.match(md, /in-progress work/);
    // Status is encoded in the comment so search can render it distinctly.
    assert.match(md, /<!-- handoff:1 field:summary topic: status:closed -->/);
    assert.match(md, /<!-- handoff:2 field:summary topic: status:open -->/);
  });

  it('materialize is idempotent (overwrites, does not append)', () => {
    dir = tmpDir();
    db = setupDb(dir);

    db.prepare("INSERT INTO handoffs (timestamp, summary, done, status, closed_at) VALUES (?,?,?,?,?)")
      .run('2026-05-25T10:00:00.000Z', 'h', 'item one; item two', 'closed', '2026-05-25T11:00:00.000Z');

    materializeHandoffsMd(dir, db);
    const first = fs.readFileSync(path.join(dir, 'handoffs.md'), 'utf8');
    materializeHandoffsMd(dir, db);
    const second = fs.readFileSync(path.join(dir, 'handoffs.md'), 'utf8');

    assert.strictEqual(first, second);
  });

  it('demotes session detail entries to fleeting', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insertLog = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );

    insertLog.run('2026-05-25T08:00:00.000Z', 'human', 'decision', 'detail', 'session entry 1', 'auth');
    insertLog.run('2026-05-25T09:00:00.000Z', 'human', 'decision', 'detail', 'session entry 2', 'db');

    // Create a handoff with session_entries pointing to logs 1 and 2
    db.prepare(`
      INSERT INTO handoffs (timestamp, summary, session_entries, status)
      VALUES (?, ?, ?, ?)
    `).run('2026-05-25T10:00:00.000Z', 'test handoff', JSON.stringify([1, 2]), 'open');

    // Simulate close — demote detail entries to fleeting
    const handoff = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();
    const entryIds = JSON.parse(handoff.session_entries || '[]');
    const placeholders = entryIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE logs SET tier = 'fleeting' WHERE id IN (${placeholders}) AND tier = 'detail'`
    ).run(...entryIds);

    const entry1 = db.prepare('SELECT * FROM logs WHERE id = 1').get();
    const entry2 = db.prepare('SELECT * FROM logs WHERE id = 2').get();

    assert.strictEqual(entry1.tier, 'fleeting');
    assert.strictEqual(entry2.tier, 'fleeting');
  });

  it('does not demote foundation entries', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insertLog = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );

    insertLog.run('2026-05-25T08:00:00.000Z', 'human', 'decision', 'foundation', 'important foundation entry', 'auth');

    // Create a handoff that includes the foundation entry in session_entries
    db.prepare(`
      INSERT INTO handoffs (timestamp, summary, session_entries, status)
      VALUES (?, ?, ?, ?)
    `).run('2026-05-25T10:00:00.000Z', 'test handoff', JSON.stringify([1]), 'open');

    // Simulate close — demote query has AND tier='detail', so foundation entries are skipped
    const handoff = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();
    const entryIds = JSON.parse(handoff.session_entries || '[]');
    const placeholders = entryIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE logs SET tier = 'fleeting' WHERE id IN (${placeholders}) AND tier = 'detail'`
    ).run(...entryIds);

    const entry = db.prepare('SELECT * FROM logs WHERE id = 1').get();

    // Foundation entries should NOT be demoted because of the AND tier='detail' guard
    assert.strictEqual(entry.tier, 'foundation');
  });

  it('sets closed_at and promoted_log_id', () => {
    dir = tmpDir();
    db = setupDb(dir);

    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    ).run('2026-05-25T10:00:00.000Z', 'test handoff', 'open');

    // Simulate close
    const row = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();
    const promotedMessage = `handoff #${row.id} closed: ${row.summary}`;
    const closeTs = '2026-05-25T18:00:00.000Z';

    const logResult = db.prepare(`
      INSERT INTO logs (timestamp, source, category, tier, message, topics)
      VALUES (?, 'agent', 'decision', 'foundation', ?, NULL)
    `).run(closeTs, promotedMessage);

    const promotedLogId = logResult.lastInsertRowid;

    db.prepare(
      "UPDATE handoffs SET status = 'closed', closed_at = ?, promoted_log_id = ? WHERE id = ?"
    ).run(closeTs, promotedLogId, row.id);

    const handoff = db.prepare('SELECT * FROM handoffs WHERE id = ?').get(row.id);

    assert.strictEqual(handoff.status, 'closed');
    assert.strictEqual(handoff.closed_at, closeTs);
    assert.strictEqual(handoff.promoted_log_id, promotedLogId);
  });
});

describe('handoff - list/latest', () => {
  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns most recent handoff with --latest logic', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    );

    insert.run('2026-05-23T10:00:00.000Z', 'first handoff', 'closed');
    insert.run('2026-05-24T10:00:00.000Z', 'second handoff', 'closed');
    insert.run('2026-05-25T10:00:00.000Z', 'third handoff', 'open');

    const row = db.prepare('SELECT * FROM handoffs ORDER BY id DESC LIMIT 1').get();

    assert(row);
    assert.strictEqual(row.id, 3);
    assert.strictEqual(row.summary, 'third handoff');
  });

  it('returns last 10 handoffs with --list logic', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    );

    // Insert 12 handoffs
    for (let i = 1; i <= 12; i++) {
      const day = String(i).padStart(2, '0');
      insert.run(`2026-05-${day}T10:00:00.000Z`, `handoff ${i}`, 'closed');
    }

    const rows = db.prepare(
      'SELECT id, timestamp, summary, topics, status FROM handoffs ORDER BY id DESC LIMIT 10'
    ).all();

    assert.strictEqual(rows.length, 10);
    // Should be IDs 12 down to 3 in reverse chronological order
    assert.strictEqual(rows[0].id, 12);
    assert.strictEqual(rows[0].summary, 'handoff 12');
    assert.strictEqual(rows[9].id, 3);
    assert.strictEqual(rows[9].summary, 'handoff 3');
  });
});

describe('handoff - edge cases', () => {
  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('close with no open handoff returns null', () => {
    dir = tmpDir();
    db = setupDb(dir);

    // Insert only a closed handoff, no open ones
    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    ).run('2026-05-25T10:00:00.000Z', 'already closed', 'closed');

    const row = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();

    assert.strictEqual(row, undefined);
  });

  it('close only affects the most recent open handoff', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    );

    insert.run('2026-05-24T10:00:00.000Z', 'first open', 'open');
    insert.run('2026-05-25T10:00:00.000Z', 'second open', 'open');

    // Simulate close — selects most recent open handoff (ORDER BY id DESC LIMIT 1)
    const row = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();

    assert(row);
    assert.strictEqual(row.id, 2);
    assert.strictEqual(row.summary, 'second open');

    // Close only that one
    const closeTs = '2026-05-25T18:00:00.000Z';
    const logResult = db.prepare(`
      INSERT INTO logs (timestamp, source, category, tier, message, topics)
      VALUES (?, 'agent', 'decision', 'foundation', ?, NULL)
    `).run(closeTs, `handoff #${row.id} closed: ${row.summary}`);

    db.prepare(
      "UPDATE handoffs SET status = 'closed', closed_at = ?, promoted_log_id = ? WHERE id = ?"
    ).run(closeTs, logResult.lastInsertRowid, row.id);

    // Verify: only handoff #2 is closed, #1 remains open
    const handoff1 = db.prepare('SELECT * FROM handoffs WHERE id = 1').get();
    const handoff2 = db.prepare('SELECT * FROM handoffs WHERE id = 2').get();

    assert.strictEqual(handoff1.status, 'open');
    assert.strictEqual(handoff2.status, 'closed');
    assert.strictEqual(handoff2.closed_at, closeTs);
  });
});

describe('handoff - field helpers', () => {
  it('splitItems splits on ; and drops empties/whitespace', () => {
    assert.deepStrictEqual(splitItems('a; b ; ;c'), ['a', 'b', 'c']);
    assert.deepStrictEqual(splitItems(''), []);
    assert.deepStrictEqual(splitItems(null), []);
    assert.deepStrictEqual(splitItems('single item only'), ['single item only']);
  });

  it('joinField folds repeated-flag arrays into one ;-joined string', () => {
    assert.strictEqual(joinField(['a', 'b']), 'a; b');        // repeated flags
    assert.strictEqual(joinField('a; b'), 'a; b');            // single ;-joined flag
    assert.strictEqual(joinField(['a; b', 'c']), 'a; b; c');  // mixed styles
    assert.strictEqual(joinField(['  a  ', '', '  ']), 'a');  // trims, drops empties
    assert.strictEqual(joinField(undefined), null);
    assert.strictEqual(joinField(null), null);
    assert.strictEqual(joinField([]), null);
  });

  it('malformedSummary REJECTS bare-number / empty / stub summaries', () => {
    // The exact junk shapes that polluted the shared store (handoffs ~15-24).
    assert.ok(malformedSummary(''), 'empty is rejected');
    assert.ok(malformedSummary('   '), 'whitespace-only is rejected');
    assert.ok(malformedSummary('4'), 'a bare number is rejected');
    assert.ok(malformedSummary('5'), 'a bare number is rejected');
    assert.ok(malformedSummary('12'), 'a multi-digit bare number is rejected');
    assert.ok(malformedSummary('list'), 'a stray subcommand word is rejected');
    assert.ok(malformedSummary('open'), 'a stray subcommand word is rejected');
    assert.ok(malformedSummary('wip'), 'a single short stub token is rejected');
    // The reason is a short string, not just truthy.
    assert.match(malformedSummary('4'), /bare number/);
    assert.match(malformedSummary('list'), /subcommand/);
  });

  it('malformedSummary ALLOWS a real summary', () => {
    assert.strictEqual(malformedSummary('wired GLM judge, blocked on env path'), null);
    assert.strictEqual(malformedSummary('refactored the segmenter'), null);
    // A single long slug-style token still reads as real work.
    assert.strictEqual(malformedSummary('refactored-the-segmenter'), null);
    // A terse but real two-word summary writes.
    assert.strictEqual(malformedSummary('fixed retire'), null);
  });
});

describe('handoff - create well-formedness guard (end to end)', () => {
  let dir;
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  function openCount(d) {
    const db = new Database(path.join(d, '.pebbl', 'db.sqlite'), { readonly: true });
    try {
      return db.prepare("SELECT COUNT(*) AS c FROM handoffs WHERE status = 'open'").get().c;
    } finally {
      db.close();
    }
  }

  it('REJECTS a bare-number summary at write time (nothing stored)', () => {
    dir = initProject();
    const r = runHandoff(dir, ['4']);
    assert.notEqual(r.status, 0, 'a bare-number handoff must exit non-zero');
    assert.match(r.stderr, /malformed/);
    // The store must be untouched — no open stub created.
    assert.strictEqual(openCount(dir), 0, 'no handoff row may be written');
  });

  it('REJECTS a stray subcommand word ("list") as a summary', () => {
    dir = initProject();
    const r = runHandoff(dir, ['list']);
    // "list" is a real flag-less arg here; the create path must bounce it, not
    // silently store it. (Note: `pebbl handoff --list` is the actual subcommand.)
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /malformed/);
    assert.strictEqual(openCount(dir), 0);
  });

  it('ALLOWS a valid summary (still writes one open handoff)', () => {
    dir = initProject();
    const r = runHandoff(dir, ['wired GLM judge, blocked on env path', '--todo', 'export FACTORY_MODELS_ENV']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
    assert.match(r.stdout, /Handoff #1 created/);
    assert.strictEqual(openCount(dir), 1, 'a valid handoff is stored as open');
  });
});

describe('handoff - repeated list flags (end to end)', () => {
  let dir;
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  function lastHandoff(d) {
    const db = new Database(path.join(d, '.pebbl', 'db.sqlite'), { readonly: true });
    try {
      return db.prepare('SELECT done, todo, blocked FROM handoffs ORDER BY id DESC LIMIT 1').get();
    } finally {
      db.close();
    }
  }

  it('keeps EVERY repeated --done/--todo item (no silent overwrite)', () => {
    dir = initProject();
    const r = runHandoff(dir, [
      'part 2: harden the factory against drift',
      '--done', 'mapped the interface',
      '--done', 'wrote the spec',
      '--todo', 'build the gate',
      '--todo', 'add a regression test',
    ]);
    assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);

    const row = lastHandoff(dir);
    assert.deepStrictEqual(splitItems(row.done), ['mapped the interface', 'wrote the spec']);
    assert.deepStrictEqual(splitItems(row.todo), ['build the gate', 'add a regression test']);
  });

  it('mixes a repeated flag with a ;-joined value', () => {
    dir = initProject();
    const r = runHandoff(dir, ['summary that is real', '--done', 'a; b', '--done', 'c']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepStrictEqual(splitItems(lastHandoff(dir).done), ['a', 'b', 'c']);
  });
});

describe('handoff - docs', () => {
  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores docs as JSON array', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const docs = JSON.stringify(['README.md', 'https://example.com/spec']);
    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status, docs) VALUES (?, ?, ?, ?)'
    ).run('2026-05-27T10:00:00.000Z', 'test', 'open', docs);

    const row = db.prepare('SELECT * FROM handoffs WHERE id = 1').get();
    const parsed = JSON.parse(row.docs);

    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0], 'README.md');
    assert.strictEqual(parsed[1], 'https://example.com/spec');
  });

  it('docs defaults to null when not provided', () => {
    dir = tmpDir();
    db = setupDb(dir);

    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    ).run('2026-05-27T10:00:00.000Z', 'test', 'open');

    const row = db.prepare('SELECT * FROM handoffs WHERE id = 1').get();
    assert.strictEqual(row.docs, null);
  });
});

describe('handoff - supersede and carry (end to end)', () => {
  const { carriedTodos } = require('../src/handoff');
  const { readEvents, foldFull } = require('../src/events');
  const rows = (dir) => {
    const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
    try { return db.prepare('SELECT id, status, todo FROM handoffs ORDER BY id').all(); } finally { db.close(); }
  };

  it('a second handoff closes the first and carries its unlisted todos', () => {
    const dir = initProject();
    try {
      assert.equal(runHandoff(dir, ['first session', '--todo', 'wire the judge; fix (a; b) parsing', '--topic', 'kiowa']).status, 0);
      const r = runHandoff(dir, ['second session', '--done', 'wire the judge', '--todo', 'ship it', '--topic', 'emporia']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Closed earlier handoff: #1/);
      assert.match(r.stdout, /from #1: fix \(a; b\) parsing/);
      const [h1, h2] = rows(dir);
      assert.equal(h1.status, 'closed');
      assert.equal(h2.status, 'open');
      assert.deepEqual(splitItems(h2.todo), ['ship it', 'from #1: fix (a; b) parsing']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a carried item keeps its origin and is not carried twice', () => {
    const dir = initProject();
    try {
      runHandoff(dir, ['first one', '--todo', 'call the county']);
      runHandoff(dir, ['second one', '--todo', 'other thing']);
      runHandoff(dir, ['third one', '--done', 'other thing']);
      const h3 = rows(dir)[2];
      assert.deepEqual(splitItems(h3.todo), ['from #1: call the county']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--keep-open leaves earlier handoffs open and carries nothing', () => {
    const dir = initProject();
    try {
      runHandoff(dir, ['first one', '--todo', 'a thing to do']);
      const r = runHandoff(dir, ['second one', '--keep-open']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(rows(dir).map((h) => [h.status, h.todo]), [['open', 'a thing to do'], ['open', null]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes handoff-open/close events the fold agrees with', () => {
    const dir = initProject();
    try {
      runHandoff(dir, ['first one', '--todo', 'x item here']);
      runHandoff(dir, ['second one']);
      const events = readEvents(path.join(dir, '.pebbl'));
      assert.deepEqual(events.filter((e) => e.type.startsWith('handoff')).map((e) => e.type),
        ['handoff-open', 'handoff-open', 'handoff-close']);
      const folded = foldFull(events).handoffs;
      assert.deepEqual(folded.map((h) => [h.summary, h.status]), [['first one', 'closed'], ['second one', 'open']]);
      assert.match(folded[1].todo, /from #1: x item here/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--close <id> also writes a handoff-close event', () => {
    const dir = initProject();
    try {
      runHandoff(dir, ['solo handoff']);
      assert.equal(runHandoff(dir, ['--close', '1']).status, 0);
      const folded = foldFull(readEvents(path.join(dir, '.pebbl'))).handoffs;
      assert.equal(folded[0].status, 'closed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carriedTodos: covered by containment either way, deduped across priors', () => {
    const priors = [
      { id: 3, todo: 'approve RM030 on board; build zero-plate pipeline' },
      { id: 4, todo: 'from #3: build zero-plate pipeline; reply to Rody' },
    ];
    assert.deepEqual(carriedTodos(priors, ['approve RM030', null]), [
      'from #3: build zero-plate pipeline',
      'from #4: reply to Rody',
    ]);
  });
});

describe('handoff - docs mode from config', () => {
  const setMode = (dir, mode) => {
    const cfg = path.join(dir, '.pebbl', 'config.yml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/docs: when-heavy/, `docs: ${mode}`));
  };
  // long (> 1200 chars) but within the item caps
  const heavy = Array.from({ length: 8 }, (_, i) => `item ${i} ` + 'detail '.repeat(21)).join('; ');

  it('never: a long handoff needs no doc', () => {
    const dir = initProject();
    try {
      setMode(dir, 'never');
      assert.equal(runHandoff(dir, ['long one', '--done', heavy]).status, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('always: even a short handoff needs --docs or --no-doc', () => {
    const dir = initProject();
    try {
      setMode(dir, 'always');
      const r = runHandoff(dir, ['short one']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /handoff\.docs: always/);
      assert.equal(runHandoff(dir, ['short one', '--no-doc']).status, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('when-heavy (default) still refuses a long undocumented handoff', () => {
    const dir = initProject();
    try {
      assert.equal(runHandoff(dir, ['long one', '--done', heavy]).status, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('handoff - item caps (end to end)', () => {
  const { itemCapViolation, MAX_ITEMS, MAX_ITEM_CHARS } = require('../src/handoff');
  const dirs = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const project = () => { const d = initProject(); dirs.push(d); return d; };
  const count = (d) => {
    const db = new Database(path.join(d, '.pebbl', 'db.sqlite'), { readonly: true });
    try { return db.prepare('SELECT COUNT(*) c FROM handoffs').get().c; } finally { db.close(); }
  };

  it('caps are 8 items per field and 160 chars per item', () => {
    assert.equal(MAX_ITEMS, 8);
    assert.equal(MAX_ITEM_CHARS, 160);
    assert.equal(itemCapViolation('a; b; c', 'done'), null);
    assert.equal(itemCapViolation(null, 'done'), null);
    assert.match(itemCapViolation(Array.from({ length: 9 }, (_, i) => `t${i}`).join('; '), 'todo'), /--todo has 9 items; the cap is 8/);
    assert.match(itemCapViolation('ok; ' + 'x'.repeat(161), 'done'), /--done item 2 is 161 chars; the cap is 160/);
    assert.equal(itemCapViolation('x'.repeat(160), 'done'), null);
  });

  it('REFUSES a ninth item, store untouched, and says to point at a doc or decision', () => {
    const d = project();
    const r = runHandoff(d, ['too many things', '--todo', Array.from({ length: 9 }, (_, i) => `thing ${i}`).join('; ')]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /--todo has 9 items; the cap is 8 per field/);
    assert.match(r.stderr, /a doc, a decision number, a file path, a commit/);
    assert.equal(count(d), 0);
  });

  it('REFUSES an item over 160 chars, store untouched', () => {
    const d = project();
    const r = runHandoff(d, ['one long item', '--done', 'fine', '--done', 'y'.repeat(161)]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /--done item 2 is 161 chars; the cap is 160 per item/);
    assert.equal(count(d), 0);
  });

  it('ACCEPTS eight items of up to 160 chars', () => {
    const d = project();
    const items = Array.from({ length: 8 }, (_, i) => `item ${i} ` + 'z'.repeat(100));
    const r = runHandoff(d, ['exactly at the cap', '--todo', items.join('; ')]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(count(d), 1);
  });
});

describe('handoff - carried todos stay within the caps', () => {
  const dirs = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const project = () => { const d = initProject(); dirs.push(d); return d; };
  // A pre-cap handoff row, written straight into db.sqlite (the CLI refuses it now).
  const seedOpen = (d, todo) => {
    const db = new Database(path.join(d, '.pebbl', 'db.sqlite'));
    try {
      db.prepare("INSERT INTO handoffs (timestamp, summary, todo, status, session_entries, session_commits) VALUES (?, ?, ?, 'open', '[]', '[]')")
        .run('2026-01-01T00:00:00.000Z', 'legacy open handoff', todo);
    } finally { db.close(); }
  };
  const latest = (d) => {
    const db = new Database(path.join(d, '.pebbl', 'db.sqlite'), { readonly: true });
    try { return db.prepare('SELECT * FROM handoffs ORDER BY id DESC LIMIT 1').get(); } finally { db.close(); }
  };

  it('REFUSES when carried + new todos would exceed 8, listing what would carry', () => {
    const d = project();
    seedOpen(d, Array.from({ length: 8 }, (_, i) => `old ${i}`).join('; '));
    const r = runHandoff(d, ['next wake', '--todo', 'new one']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /--todo would hold 9 items \(1 new \+ 8 carried from open handoff #1\); the cap is 8/);
    assert.match(r.stderr, /from #1: old 7/);
    assert.match(r.stderr, /--keep-open/);
    assert.equal(latest(d).summary, 'legacy open handoff', 'nothing written, #1 still the latest');
    assert.equal(latest(d).status, 'open');
  });

  it('passes once finished items are listed in --done, and the rest carry', () => {
    const d = project();
    seedOpen(d, Array.from({ length: 8 }, (_, i) => `old ${i}`).join('; '));
    const r = runHandoff(d, ['next wake', '--done', 'old 0; old 1', '--todo', 'new one']);
    assert.equal(r.status, 0, r.stderr);
    const todos = splitItems(latest(d).todo);
    assert.equal(todos.length, 7);
    assert.equal(todos[0], 'new one');
    assert.ok(todos.includes('from #1: old 7'));
  });

  it('clips an over-long legacy todo to 160 chars with …, naming its handoff', () => {
    const d = project();
    const monster = 'decide the visual gate question (see jig) ' + 'w'.repeat(400);
    seedOpen(d, `${monster}; small one`);
    const r = runHandoff(d, ['next wake', '--todo', 'new one']);
    assert.equal(r.status, 0, r.stderr);
    const todos = splitItems(latest(d).todo);
    assert.equal(todos.length, 3);
    const clipped = todos.find((t) => t.startsWith('from #1: decide'));
    assert.ok(clipped, latest(d).todo);
    // The clip is on the item text; the "from #1: " prefix rides on top of it.
    assert.equal(clipped.slice('from #1: '.length).length, 160);
    assert.ok(clipped.endsWith('…'));
    assert.match(r.stdout, /clipped to 160 chars; the full text is in the handoff it names/);
  });

  it('carries an item that fit the cap WHOLE, so its trailing pointer survives', () => {
    const d = project();
    // 156 chars, pointer at the end: clipping the prefixed string (165 chars) used
    // to back up before the "(" and drop the pointer, the one part that mattered.
    const item = 'decide the gate question with the owner, the visual check vs the numeric one, ' +
      'then wire the result into the pipeline step that runs nightly (docs/14.02 §3)';
    assert.ok(item.length > 150 && item.length <= 160, `item is ${item.length} chars`);
    const r1 = runHandoff(d, ['first wake', '--todo', item]);
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = runHandoff(d, ['second wake', '--todo', 'new one']);
    assert.equal(r2.status, 0, r2.stderr);
    const todos = splitItems(latest(d).todo);
    assert.ok(todos.includes(`from #1: ${item}`), latest(d).todo);
    assert.doesNotMatch(r2.stdout, /clipped/);
  });
});

describe('handoff - commit captures are not session entries', () => {
  const dirs = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

  it('--latest lists what the session logged and counts hook captures without listing them', () => {
    const d = initProject();
    dirs.push(d);
    const db = new Database(path.join(d, '.pebbl', 'db.sqlite'));
    const ins = db.prepare("INSERT INTO logs (timestamp, source, category, tier, message) VALUES (?, ?, ?, ?, ?)");
    const now = new Date().toISOString();
    ins.run(now, 'hook', 'uncategorized', 'fleeting', 'memory: pebbl decisions through 2026-10-01 (2+/0-)');
    ins.run(now, 'hook', 'decision', 'fleeting', 'fix: commit message classified as decision');
    ins.run(now, 'human', 'decision', 'component', 'REAL-ENTRY chose x because y');
    // A pre-change handoff row whose session_entries still include the captures.
    db.prepare("INSERT INTO handoffs (timestamp, summary, status, session_entries, session_commits) VALUES (?, 'legacy row', 'open', ?, '[]')")
      .run(now, JSON.stringify([1, 2, 3]));
    db.close();
    const r = runHandoff(d, ['--latest']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Session entries \(1, 2 commit captures not shown\):/);
    assert.match(r.stdout, /REAL-ENTRY/);
    assert.doesNotMatch(r.stdout, /\[fleeting\|uncategorized\]/);
    assert.doesNotMatch(r.stdout, /commit message classified/);
  });

  it('a new handoff does not collect hook captures as session entries', () => {
    const d = initProject();
    dirs.push(d);
    const db = new Database(path.join(d, '.pebbl', 'db.sqlite'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO logs (timestamp, source, category, tier, message) VALUES (?, 'hook', 'uncategorized', 'fleeting', 'a commit')").run(now);
    db.prepare("INSERT INTO logs (timestamp, source, category, tier, message) VALUES (?, 'human', 'decision', 'component', 'a real one')").run(now);
    db.close();
    const r = runHandoff(d, ['fresh handoff', '--todo', 'x thing']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Session: 1 log entries/);
  });
});
