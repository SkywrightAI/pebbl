'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

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
      corrects   INTEGER,
      valid_from TEXT,
      valid_to   TEXT,
      invalidated_by INTEGER
    );
  `);
  return db;
}

describe('compact - buildGroups', () => {
  const { buildGroups } = require('../src/compact');

  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('groups entries by category/primaryTopic/quarter above threshold', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );
    // May = month 5 → Q2.
    for (let i = 0; i < 5; i++) {
      insert.run('2026-05-0' + (i + 1), 'human', 'decision', 'detail', `decision ${i}`, 'auth,security');
    }
    for (let i = 0; i < 3; i++) {
      insert.run('2026-05-0' + (i + 1), 'human', 'structure', 'detail', `structure ${i}`, 'api');
    }

    const { groups } = buildGroups(db, 4);

    assert(groups.has('decision/auth/2026-Q2'));
    assert.strictEqual(groups.get('decision/auth/2026-Q2').length, 5);
    assert(!groups.has('structure/api/2026-Q2'));
  });

  it('filters groups below threshold', () => {
    const { groups } = buildGroups(db, 6);
    assert(!groups.has('decision/auth/2026-Q2'));
  });

  it('puts uncategorized entries in ambiguous list', () => {
    const insert = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insert.run('2026-05-10', 'human', 'uncategorized', 'detail', 'ambiguous note', 'random');

    const { ambiguous } = buildGroups(db, 10);
    const found = ambiguous.find(e => e.message === 'ambiguous note');
    assert(found);
    assert.strictEqual(found.category, 'uncategorized');
  });

  it('puts fleeting entries in fleeting list (not groups)', () => {
    const insert = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insert.run('2026-05-10', 'agent', 'decision', 'fleeting', 'old fleeting note', 'auth');

    const { groups, fleeting } = buildGroups(db, 4);
    const found = fleeting.find(e => e.message === 'old fleeting note');
    assert(found);
    assert.strictEqual(found.tier, 'fleeting');
    // Fleet entries should not be in groups
    const group = groups.get('decision/auth/2026-Q2');
    if (group) {
      const inGroup = group.find(e => e.tier === 'fleeting');
      assert(!inGroup);
    }
  });

  it('handles entries without topics (defaults to general)', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < 12; i++) {
      insert.run('2026-05-0' + (i % 9 + 1), 'human', 'pattern', 'detail', `pattern ${i}`, null);
    }

    const { groups } = buildGroups(db, 10);
    assert(groups.has('pattern/general/2026-Q2'));
  });

  it('groups across different quarters separately', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );
    // May = month 5 → Q2; August = month 8 → Q3. Same category/topic but
    // different quarters must land in separate buckets (months within a quarter
    // would now collapse together, so we straddle the Q2/Q3 boundary).
    for (let i = 0; i < 5; i++) {
      insert.run('2026-05-0' + (i + 1), 'human', 'data', 'detail', `may ${i}`, 'storage');
    }
    for (let i = 0; i < 5; i++) {
      insert.run('2026-08-0' + (i + 1), 'human', 'data', 'detail', `august ${i}`, 'storage');
    }

    const { groups } = buildGroups(db, 5);
    assert(groups.has('data/storage/2026-Q2'));
    assert(groups.has('data/storage/2026-Q3'));
    assert.strictEqual(groups.get('data/storage/2026-Q2').length, 5);
    assert.strictEqual(groups.get('data/storage/2026-Q3').length, 5);
  });
});

describe('compact - execute helpers', () => {
  const { buildGroups, regenerateMarkdown, generateRollupMessage } = require('../src/compact');

  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('generateRollupMessage produces correct rollup text', () => {
    const entries = [
      { category: 'decision', topics: 'auth,security', timestamp: '2026-05-01T00:00:00Z', message: 'chose JWT' },
      { category: 'decision', topics: 'auth,security', timestamp: '2026-05-02T00:00:00Z', message: 'added refresh tokens' },
    ];
    const msg = generateRollupMessage(entries);
    assert(msg.includes('[rollup]'));
    assert(msg.includes('decision notes on auth'));
    // May timestamps → Q2; rollup labels by quarter.
    assert(msg.includes('2026-Q2'));
    assert(msg.includes('chose JWT'));
    assert(msg.includes('added refresh tokens'));
  });

  it('generateRollupMessage dedupes exact-duplicate source messages (runaway-logger shape)', () => {
    // The 2026-07-12 loom store carried 45 identical entries from a runaway
    // logger; the rollup must name the fact once, not 45 times. Distinct
    // messages still all appear, in first-seen order.
    const dupe = (ts) => ({ category: 'steering', topics: 'ops', timestamp: ts, message: 'guard false-positives at small corpus' });
    const entries = [
      dupe('2026-07-12T00:00:01Z'),
      dupe('2026-07-12T00:00:02Z'),
      { category: 'steering', topics: 'ops', timestamp: '2026-07-12T00:00:03Z', message: 'a distinct second fact' },
      dupe('2026-07-12T00:00:04Z'),
    ];
    const msg = generateRollupMessage(entries);
    assert.equal(msg.split('guard false-positives at small corpus').length - 1, 1, 'duplicate message appears exactly once');
    assert(msg.includes('a distinct second fact'));
    assert(msg.indexOf('guard false-positives') < msg.indexOf('a distinct second fact'), 'first-seen order preserved');
  });

  // P3 (event-sourcing): the old `archiveEntries creates archive file` test is
  // DELETED. archiveEntries + archive/*.txt + archive.md no longer exist — the
  // append-only events.jsonl IS the durable archive (a rolled-up source stays in
  // the log forever; the fold hides it). The append-only / zero-deletion
  // behavior that REPLACES it is covered end-to-end in
  // test/compact-append-only.test.js.
  it('compact.js no longer exports or defines archiveEntries (machinery deleted)', () => {
    const compact = require('../src/compact');
    assert.equal(compact.archiveEntries, undefined, 'archiveEntries must be gone from exports');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'compact.js'), 'utf8');
    assert.doesNotMatch(src, /function archiveEntries/, 'archiveEntries function must be deleted');
    assert.doesNotMatch(src, /db\.transaction/, 'the destructive db.transaction must be gone');
    assert.doesNotMatch(src, /INSERT INTO logs|DELETE FROM logs|UPDATE logs/, 'no destructive SQL against logs');
  });

  it('regenerateMarkdown rebuilds manual-logs.md from SQLite', () => {
    dir = tmpDir();
    db = new Database(path.join(dir, 'db.sqlite'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT 'human',
        category   TEXT NOT NULL DEFAULT 'uncategorized',
        tier       TEXT NOT NULL DEFAULT 'detail',
        message    TEXT NOT NULL,
        topics     TEXT,
        relates_to INTEGER,
        corrects   INTEGER,
        valid_from TEXT,
        valid_to   TEXT,
        invalidated_by INTEGER
      );
    `);
    db.prepare('INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)')
      .run('2026-05-23T12:00:00Z', 'human', 'decision', 'component', 'chose SQLite', 'datastore');

    regenerateMarkdown(dir);

    const md = fs.readFileSync(path.join(dir, 'manual-logs.md'), 'utf8');
    assert(md.includes('# Manual Logs'));
    assert(md.includes('chose SQLite'));
    assert(md.includes('cat:decision topic:datastore tier:component'));
  });
});
