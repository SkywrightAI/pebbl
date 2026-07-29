'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { migrate, getVersion } = require('../src/migrate');
const { ensureProjectFiles } = require('../src/rubric');

let dirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-test-'));
  dirs.push(d);
  return d;
}

function oldDb(dir) {
  const dbPath = path.join(dir, 'db.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      source    TEXT NOT NULL DEFAULT 'manual',
      message   TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO logs (timestamp, source, message) VALUES (?, ?, ?)").run(
    new Date().toISOString(), 'manual', 'test entry'
  );
  db.close();
  return dbPath;
}

after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe('migrate', () => {
  it('is no-op on new db (already has v0.2 schema)', () => {
    const dir = tmpDir();
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
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0.2');
    `);
    migrate(db);
    // Re-pointed 0.6 -> 0.7: the migration chain now ends at v0.7 (tier-derived
    // importance backfill). The ordering/schema this test cares about is
    // unchanged; only the terminal version moved because a new step was added.
    assert.strictEqual(getVersion(db), 0.7);
    const cols = db.prepare("PRAGMA table_info(logs)").all();
    const names = cols.map(c => c.name);
    assert(names.includes('category'));
    assert(names.includes('tier'));
    assert(names.includes('topics'));
    // v0.3: migration is a no-op on a new DB (no signal entries to rename)
    const tierDefault = cols.find(c => c.name === 'tier');
    assert.strictEqual(tierDefault.dflt_value, "'detail'");
    db.close();
  });

  it('adds missing columns and normalizes source on old v0.1 db', () => {
    const dir = tmpDir();
    const dbPath = oldDb(dir);
    const db = new Database(dbPath);
    migrate(db);

    // Re-pointed 0.6 -> 0.7: terminal version moved (v0.7 backfill added).
    assert.strictEqual(getVersion(db), 0.7);

    const cols = db.prepare("PRAGMA table_info(logs)").all();
    const names = cols.map(c => c.name);
    assert(names.includes('category'));
    assert(names.includes('tier'));
    assert(names.includes('topics'));
    assert(names.includes('relates_to'));
    assert(names.includes('corrects'));

    const categoryCol = cols.find(c => c.name === 'category');
    assert.strictEqual(categoryCol.dflt_value, "'uncategorized'");

    const tierCol = cols.find(c => c.name === 'tier');
    assert.strictEqual(tierCol.dflt_value, "'detail'");

    const row = db.prepare("SELECT category, tier, source FROM logs WHERE message = 'test entry'").get();
    assert.strictEqual(row.category, 'uncategorized');
    assert.strictEqual(row.tier, 'detail');
    assert.strictEqual(row.source, 'human');

    db.close();
  });

  it('is idempotent (running twice does not error)', () => {
    const dir = tmpDir();
    const dbPath = oldDb(dir);
    const db = new Database(dbPath);

    migrate(db);
    assert.strictEqual(getVersion(db), 0.7); // re-pointed 0.6 -> 0.7

    assert.doesNotThrow(() => {
      migrate(db);
    });

    assert.strictEqual(getVersion(db), 0.7); // re-pointed 0.6 -> 0.7

    const cols = db.prepare("PRAGMA table_info(logs)").all();
    const names = cols.map(c => c.name);
    assert(names.includes('category'));
    assert(names.includes('tier'));

    db.close();
  });
});

describe('migrate v0.6 (rerank signals)', () => {
  const RERANK_COLS = ['importance', 'access_count', 'last_accessed'];

  // A db already at the v0.5 schema: logs has the bitemporal columns and meta
  // says 0.5. The v0.6 migration must add exactly the three rerank columns.
  function v05Db(dir) {
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
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0.5');
    `);
    return db;
  }

  it('bumps to v0.6 and adds the three rerank columns on a fresh openDb db', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.pebbl'));
    const { openDb } = require('../src/db');
    const db = openDb(path.join(dir, '.pebbl'));
    // Re-pointed 0.6 -> 0.7: openDb runs the full chain, which now ends at v0.7.
    // The v0.6 rerank columns this test asserts still get added.
    assert.strictEqual(getVersion(db), 0.7);
    const names = db.prepare('PRAGMA table_info(logs)').all().map(c => c.name);
    for (const c of RERANK_COLS) assert(names.includes(c), `missing column ${c}`);
    db.close();
  });

  it('adds the three rerank columns on a prior-version (v0.5) db, with sane defaults', () => {
    const dir = tmpDir();
    const db = v05Db(dir);
    db.prepare('INSERT INTO logs (timestamp, message) VALUES (?, ?)')
      .run('2026-01-01T00:00:00.000Z', 'an existing belief');
    migrate(db);
    // Re-pointed 0.6 -> 0.7: full chain ends at v0.7.
    assert.strictEqual(getVersion(db), 0.7);

    const cols = db.prepare('PRAGMA table_info(logs)').all();
    const names = cols.map(c => c.name);
    for (const c of RERANK_COLS) assert(names.includes(c), `missing column ${c}`);

    // defaults exist for the score to read against pre-v0.6 rows
    const importance = cols.find(c => c.name === 'importance');
    const accessCount = cols.find(c => c.name === 'access_count');
    assert.strictEqual(importance.type, 'REAL');
    assert.strictEqual(accessCount.type, 'INTEGER');

    // CHANGED by v0.7: this row's tier defaults to 'detail' (the v05Db schema's
    // NOT NULL DEFAULT 'detail'), so the v0.7 tier-derived backfill sets its
    // importance to 2 (detail), not the bare 0 the v0.6 column default gave. The
    // 0-default is now only what a tier-LESS / unknown-tier row keeps. This is the
    // genuine new behavior; access_count/last_accessed remain at the v0.6 defaults.
    const row = db.prepare('SELECT importance, access_count, last_accessed, tier FROM logs WHERE message = ?')
      .get('an existing belief');
    assert.strictEqual(row.tier, 'detail');      // schema default applied at insert
    assert.strictEqual(row.importance, 2);       // v0.7 backfilled detail -> 2
    assert.strictEqual(row.access_count, 0);     // untouched by v0.7
    assert.strictEqual(row.last_accessed, null); // untouched by v0.7
    db.close();
  });

  it('is idempotent: a second migrate does not error or change version', () => {
    const dir = tmpDir();
    const db = v05Db(dir);
    migrate(db);
    assert.strictEqual(getVersion(db), 0.7); // re-pointed 0.6 -> 0.7
    assert.doesNotThrow(() => migrate(db));
    assert.strictEqual(getVersion(db), 0.7); // re-pointed 0.6 -> 0.7
    db.close();
  });
});

// v0.7 backfill: tier-derived importance on existing rows. New behavior, so a
// dedicated block proves it (the v0.6 block above only proves the columns + 0
// defaults, which v0.7 then fills in for tier-bearing rows).
describe('migrate v0.7 (tier-derived importance backfill)', () => {
  function v06Db(dir) {
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
        invalidated_by INTEGER,
        importance REAL DEFAULT 0,
        access_count INTEGER DEFAULT 0,
        last_accessed TEXT DEFAULT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0.6');
    `);
    return db;
  }

  it('backfills importance from tier (foundation 5 / component 4 / detail 2 / fleeting 1), only on 0-default rows', () => {
    const dir = tmpDir();
    const db = v06Db(dir);
    const ins = db.prepare('INSERT INTO logs (timestamp, tier, message, importance) VALUES (?, ?, ?, ?)');
    ins.run('2026-01-01T00:00:00.000Z', 'foundation', 'f', 0);
    ins.run('2026-01-01T00:00:00.000Z', 'component', 'c', 0);
    ins.run('2026-01-01T00:00:00.000Z', 'detail', 'd', 0);
    ins.run('2026-01-01T00:00:00.000Z', 'fleeting', 'fl', 0);
    // A row with a hand-set importance must NOT be clobbered by the backfill.
    ins.run('2026-01-01T00:00:00.000Z', 'detail', 'hand', 5);

    migrate(db);
    assert.strictEqual(getVersion(db), 0.7);

    const imp = (msg) => db.prepare('SELECT importance FROM logs WHERE message = ?').get(msg).importance;
    assert.strictEqual(imp('f'), 5);
    assert.strictEqual(imp('c'), 4);
    assert.strictEqual(imp('d'), 2);
    assert.strictEqual(imp('fl'), 1);
    assert.strictEqual(imp('hand'), 5, 'hand-set importance preserved (only 0-defaults are touched)');
    db.close();
  });

  it('is idempotent: re-running the backfill does not change a previously-set importance', () => {
    const dir = tmpDir();
    const db = v06Db(dir);
    db.prepare('INSERT INTO logs (timestamp, tier, message, importance) VALUES (?, ?, ?, ?)')
      .run('2026-01-01T00:00:00.000Z', 'foundation', 'f', 0);
    migrate(db); // 0 -> 5
    assert.strictEqual(db.prepare("SELECT importance FROM logs WHERE message='f'").get().importance, 5);
    assert.doesNotThrow(() => migrate(db)); // 5 is not 0, so untouched
    assert.strictEqual(db.prepare("SELECT importance FROM logs WHERE message='f'").get().importance, 5);
    db.close();
  });
});

describe('ensureProjectFiles', () => {
  let dir;

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates rubric.yml and config.yml if missing', () => {
    dir = tmpDir();
    ensureProjectFiles(dir);
    assert(fs.existsSync(path.join(dir, 'rubric.yml')));
    assert(fs.existsSync(path.join(dir, 'config.yml')));
  });

  it('does not overwrite existing rubric.yml, but applies migrations', () => {
    dir = tmpDir();
    const custom = 'rules:\n  - pattern: "custom"\n    category: quality\n    tier: component\n';
    fs.writeFileSync(path.join(dir, 'rubric.yml'), custom);
    ensureProjectFiles(dir);
    const content = fs.readFileSync(path.join(dir, 'rubric.yml'), 'utf8');
    assert(content.includes('custom'), 'custom rules preserved');
    assert(content.includes('^trace:'), 'trace rule migrated in');
  });

  // v0.7: rubrics predating the steering rule never gained it — the v0.5/v0.6
  // steps only edit a rule that is already there.
  it('inserts the steering rule when the rubric has none', () => {
    dir = tmpDir();
    const preSteering = [
      '# header comment',
      '',
      'rules:',
      '  - pattern: "^\\[session\\]"',
      '    category: uncategorized',
      '    tier: fleeting',
      '',
      '  - pattern: "^trace:"',
      '    category: quality',
      '    tier: detail',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'rubric.yml'), preSteering);
    ensureProjectFiles(dir);
    const content = fs.readFileSync(path.join(dir, 'rubric.yml'), 'utf8');
    assert(/category:\s*steering/.test(content), 'steering rule inserted');
    assert(content.includes('parked|friction|'), 'steering pattern catches friction');
    assert(content.indexOf('^trace:') < content.indexOf('category: steering'),
      'steering lands below the trace rule, matching DEFAULT_RUBRIC order');
    assert(content.search(/\[session/) < content.indexOf('category: steering'),
      'the [session] rule keeps first-match priority over the inserted rule');

    // The rule must actually classify, not just be present as text.
    const { loadRubric, classifyEntry } = require('../src/rubric');
    const hit = classifyEntry(loadRubric(dir), 'regression in the exporter after the refactor');
    assert.strictEqual(hit.category, 'steering');
  });

  it('is idempotent: a rubric that already has steering is untouched', () => {
    dir = tmpDir();
    ensureProjectFiles(dir); // writes DEFAULT_RUBRIC, which has steering
    const first = fs.readFileSync(path.join(dir, 'rubric.yml'), 'utf8');
    ensureProjectFiles(dir);
    const second = fs.readFileSync(path.join(dir, 'rubric.yml'), 'utf8');
    assert.strictEqual(second, first, 're-running migrations is a no-op');
    assert.strictEqual((second.match(/category: steering/g) || []).length, 1,
      'steering rule not duplicated');
  });

  // v0.8: the old v0.4 anchor wrote the trace rule above `rules:` whenever the
  // session pattern was escaped. pebbl's lenient parser read it anyway, so the
  // damage was invalid YAML rather than a broken rubric.
  it('moves rules stranded above the rules: key back underneath it', () => {
    dir = tmpDir();
    const malformed = [
      '# header comment',
      '',
      '  - pattern: "^trace:"',
      '    category: quality',
      '    tier: detail',
      '',
      'rules:',
      '  - pattern: "custom"',
      '    category: quality',
      '    tier: component',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'rubric.yml'), malformed);
    ensureProjectFiles(dir);
    const content = fs.readFileSync(path.join(dir, 'rubric.yml'), 'utf8');
    const rulesIdx = content.search(/^rules:/m);
    const firstRuleIdx = content.search(/^[ \t]+- pattern:/m);
    assert(rulesIdx !== -1, 'rules: key kept');
    assert(rulesIdx < firstRuleIdx, 'every rule now sits below rules:');
    assert(content.includes('^trace:'), 'stray rule preserved, not dropped');
    assert(content.includes('custom'), 'pre-existing rule preserved');
    assert.strictEqual((content.match(/\^trace:/g) || []).length, 1, 'stray rule not duplicated');

    const { loadRubric, classifyEntry } = require('../src/rubric');
    const rules = loadRubric(dir);
    assert.strictEqual(classifyEntry(rules, 'trace: shipped the thing').category, 'quality');
    assert.strictEqual(classifyEntry(rules, 'custom').category, 'quality');
  });

  // Regression: repairing a real-world rubric (custom lead rule + escaped
  // session pattern + a stray rule above `rules:`) must not demote the
  // [session] rule below the unanchored keyword rules it has to outrank.
  it('keeps the [session] rule first-match when repairing a customised rubric', () => {
    dir = tmpDir();
    const lumrShaped = [
      '# Pebbl classification rubric',
      '',
      '  - pattern: "^trace:"',
      '    category: quality',
      '    tier: detail',
      '',
      'rules:',
      '  - pattern: "youtube transcript|video transcript|transcript:"',
      '    category: transcript',
      '    tier: reference',
      '    notes_dir: transcripts/',
      '',
      '  - pattern: "^\\[session\\]"',
      '    category: uncategorized',
      '    tier: fleeting',
      '',
      '  - pattern: "chose|decided|decision|picked|went with|trade-?off|constraint|switched|replaced|changed to|adopted|rejected|dropped|reverted|migrated"',
      '    category: decision',
      '    tier: component',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'rubric.yml'), lumrShaped);
    ensureProjectFiles(dir);
    const content = fs.readFileSync(path.join(dir, 'rubric.yml'), 'utf8');
    assert(content.search(/^rules:/m) < content.search(/^[ \t]+- pattern:/m), 'valid shape');
    assert(content.search(/\[session/) < content.indexOf('category: steering'),
      '[session] still outranks the inserted steering rule');
    assert(content.indexOf('transcript:') < content.search(/\[session/),
      'the custom lead rule keeps its position');

    const { loadRubric, classifyEntry } = require('../src/rubric');
    const rules = loadRubric(dir);
    // The payoff: a session dump that merely mentions a regression stays
    // fleeting instead of being filed as steering.
    assert.strictEqual(classifyEntry(rules, '[session] notes: hit a regression mid-run').tier, 'fleeting');
    assert.strictEqual(classifyEntry(rules, 'regression in the exporter').category, 'steering');
  });
});
