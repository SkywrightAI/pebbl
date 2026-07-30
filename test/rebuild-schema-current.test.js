'use strict';
// Rebuild schema stamp — the migration re-run noise after a compaction.
// rebuildReadModelFromEvents regenerates db.sqlite via writeViewSqlite (which
// writes the CURRENT post-v0.7 read contract) but used to stamp
// schema_version '0.5'. The very next command's openDb -> migrate() then
// re-ran (and re-announced) every migration above the stamp — "pebbl:
// migrated db to v0.6 (rerank signals)" / "... v0.7 (tier-derived importance
// backfill)" after EVERY compaction or repair, alarming the operator and
// re-doing migration work on each post-rebuild read. Two guarantees:
//   1. A rebuilt store lands at the version a fresh store gets (the rebuild
//      runs the migration chain itself, once, quietly), so a post-compaction
//      read prints NO migration output.
//   2. migrate(db, { quiet: true }) is silent; the default stays loud (the
//      operator-facing announcement on a genuinely old store is unchanged).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const { migrate, getVersion } = require('../src/migrate');

const NODE = process.execPath;
const HERMETIC_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-rebuild-schema-'));
  const env = { ...process.env, PATH: HERMETIC_PATH };
  const run = (args) => execFileSync(NODE, [BIN, ...args], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const runCapture = (args) => spawnSync(NODE, [BIN, ...args], { cwd: dir, env, encoding: 'utf8' });
  run(['init']);
  return { dir, run, runCapture };
}

// A compactable group so `compact --execute` actually appends a batch and
// triggers rebuildReadModelFromEvents (the db.sqlite regeneration under test).
function fillCompactableGroup(run) {
  for (let i = 1; i <= 12; i++) {
    run(['log', `widget note ${i} for the system`, '--cat', 'data', '--tier', 'detail', '--topic', 'widgets']);
  }
}

function storeVersion(dir) {
  const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
  try {
    return getVersion(db);
  } finally {
    db.close();
  }
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('rebuild-from-events leaves the store at the current schema version', () => {
  it('a read after compact --execute prints NO migration output; the stamp matches a fresh store', () => {
    const { dir, run, runCapture } = freshStore();
    try {
      // A fresh store (openDb ran the full chain at init) defines "current".
      const current = storeVersion(dir);
      assert.ok(current >= 0.7, `fresh store is at least v0.7 (got ${current})`);

      fillCompactableGroup(run);
      const compact = runCapture(['compact', '--execute']);
      assert.equal(compact.status, 0, `compact must exit 0 (stderr: ${compact.stderr})`);

      // The rebuilt db.sqlite is stamped current — NOT the pre-rerank 0.5
      // floor that made every later read re-run the chain.
      assert.equal(storeVersion(dir), current, 'rebuilt store stamped at the current schema version');

      // The regression itself: the NEXT command after a compaction used to
      // announce "migrated db to v0.6/v0.7" on stderr, every time.
      const read = runCapture(['context']);
      assert.equal(read.status, 0, `context must exit 0 (stderr: ${read.stderr})`);
      assert.doesNotMatch(read.stderr, /migrated db/, `post-compaction read must not re-announce migrations (stderr: ${read.stderr})`);
      assert.doesNotMatch(read.stdout, /migrated db/);

      // And it did not just defer the noise: the stamp survives the read too.
      assert.equal(storeVersion(dir), current, 'stamp still current after the read');
    } finally {
      cleanup(dir);
    }
  });

  it('migrate({quiet}) is silent; the default announcement on an old store stays loud', () => {
    // A db at the v0.5 shape + stamp, twice — one migrated quietly, one loud.
    const makeV05 = () => {
      const db = new Database(':memory:');
      db.exec(`
        CREATE TABLE logs (
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
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta (key, value) VALUES ('schema_version', '0.5');
      `);
      return db;
    };

    const captured = [];
    const realError = console.error;
    console.error = (msg) => captured.push(String(msg));
    try {
      const quietDb = makeV05();
      migrate(quietDb, { quiet: true });
      assert.equal(getVersion(quietDb), 0.8, 'quiet still migrates all the way');
      assert.equal(captured.length, 0, `quiet migrate must print nothing (got: ${captured.join(' | ')})`);
      quietDb.close();

      const loudDb = makeV05();
      migrate(loudDb);
      assert.equal(getVersion(loudDb), 0.8);
      assert.ok(captured.some((m) => /migrated db to v0\.6/.test(m)), 'default migrate still announces v0.6');
      assert.ok(captured.some((m) => /migrated db to v0\.8/.test(m)), 'default migrate still announces v0.8');
      loudDb.close();
    } finally {
      console.error = realError;
    }
  });
});
