'use strict';
// R4 — identity-keyed assert + outcome (schema v0.8).
//
// THE MEASURED PROBLEM: in ~/loom/.pebbl, 711 append events fold to 487 distinct
// messages and 305 live rows. One message exists 46 times
// ("t-6bb26ff4: COLLISION-GUARD FALSE POSITIVES"), two "recurring operational
// mess" signatures 44 and 35 times — the maintenance plane re-logs the same
// finding on every pass. No amount of retrieval helps a reader wading through 46
// copies of one entry, so the fix is on the WRITE side: `append(prose)` is not
// idempotent, but an assert carrying an identity key can be.
//
// THE CONTRACT THESE TESTS FREEZE:
//   (a) `pebbl log --key <k>` on a key with no LIVE row inserts one row,
//       assert_key = k, occurrences = 1.
//   (b) `pebbl log --key <k>` on a key that HAS a live row inserts NOTHING —
//       not a db row, not a markdown block. It increments occurrences.
//   (c) Identity is scoped to LIVE beliefs. Once a row is superseded
//       (valid_to set), its key is free and the next assert inserts fresh.
//   (d) WITHOUT --key, behavior is byte-identical to today: two identical
//       messages produce two rows. The dedup must never leak into the default
//       path.
//   (e) `--outcome failed|worked` persists; any other value is refused.
//   (f) readback surfaces a precedent's failed outcome, so "we tried this and
//       it didn't work" reaches a builder instead of dying in the store.
//   (g) The fold moves with the db: a `reassert` event folds to the same
//       occurrences count the db row carries. Without this, events-mode stores
//       and the fold-equivalence check silently stop covering the new columns.
//
// WHY EACH TEST BITES (what to neuter to make it go red):
//   - drop the dedup branch in log.js  -> (b), (c) dedup counts, (g) parity fail
//   - make the dedup unconditional     -> (d) goes red
//   - skip the markdown guard          -> (b)'s manual-logs.md assertion goes red
//   - forget 'reassert' in KNOWN_TYPES -> (g) goes red
//   - drop the outcome validator       -> (e) goes red
//   - don't thread outcome to readback -> (f) goes red
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { migrate, getVersion } = require('../src/migrate');
const { openDb } = require('../src/db');
const { foldFull } = require('../src/fold');
const log = require('../src/log');
const readback = require('../src/readback');

let dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-assert-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Same harness the bitemporal suite uses: run the REAL `pebbl log` CLI against a
// temp store, intercepting process.exit so a refusal is an assertable value
// rather than a killed test runner.
class ExitSignal extends Error {}
function runLogCli(pebblDir, args) {
  const dir = path.dirname(pebblDir);
  const origCwd = process.cwd();
  const origExit = process.exit;
  const origErr = console.error;
  const errLines = [];
  let exitCode = 0;
  process.chdir(dir);
  process.exit = (code) => { exitCode = code || 0; throw new ExitSignal(); };
  console.error = (...a) => errLines.push(a.join(' '));
  try {
    log(args);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    process.chdir(origCwd);
    process.exit = origExit;
    console.error = origErr;
  }
  return { exitCode, stderr: errLines.join('\n') };
}

// A store whose schema is created + migrated by the real openDb path.
function freshStore() {
  const dir = tmpDir();
  const pebblDir = path.join(dir, '.pebbl');
  fs.mkdirSync(pebblDir);
  const db = openDb(pebblDir);
  db.close();
  return pebblDir;
}

function rows(pebblDir, sql, ...params) {
  const db = openDb(pebblDir);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

// A realistic recurring finding — the shape the maintenance plane re-logs.
const MESS = 'recurring operational mess [sig-4c93ec7045c9b] because the '
  + 'custodian re-emits the same site-anchored finding on every maintenance pass';

// ---------------------------------------------------------------------------

describe('R4 migration (v0.8) — additive identity columns', () => {
  it('bumps to v0.8 and adds assert_key, occurrences, outcome', () => {
    const pebblDir = freshStore();
    const db = openDb(pebblDir);
    try {
      assert.ok(getVersion(db) >= 0.8, `expected schema >= 0.8, got ${getVersion(db)}`);
      const cols = new Set(db.prepare('PRAGMA table_info(logs)').all().map(c => c.name));
      assert.ok(cols.has('assert_key'), 'logs.assert_key missing');
      assert.ok(cols.has('occurrences'), 'logs.occurrences missing');
      assert.ok(cols.has('outcome'), 'logs.outcome missing');
    } finally {
      db.close();
    }
  });

  it('is idempotent — a second migrate on the same db is a no-op', () => {
    const pebblDir = freshStore();
    const db = openDb(pebblDir);
    try {
      const before = getVersion(db);
      migrate(db, { quiet: true });
      assert.equal(getVersion(db), before);
      const cols = db.prepare('PRAGMA table_info(logs)').all().map(c => c.name);
      // No duplicate columns from a re-run.
      assert.equal(new Set(cols).size, cols.length);
    } finally {
      db.close();
    }
  });

  it('leaves a keyless entry at the column defaults (existing rows unaffected)', () => {
    const pebblDir = freshStore();
    const r = runLogCli(pebblDir, ['a plain entry with no identity key, because it is the default path']);
    assert.equal(r.exitCode, 0, r.stderr);
    const [row] = rows(pebblDir, 'SELECT assert_key, occurrences, outcome FROM logs');
    assert.equal(row.assert_key, null);
    assert.equal(row.occurrences, 1);
    assert.equal(row.outcome, null);
  });
});

describe('R4 identity-keyed assert', () => {
  it('first assert of a key inserts one row with occurrences 1', () => {
    const pebblDir = freshStore();
    const r = runLogCli(pebblDir, [MESS, '--key', 'sig-4c93ec7045c9b']);
    assert.equal(r.exitCode, 0, r.stderr);
    const got = rows(pebblDir, 'SELECT assert_key, occurrences FROM logs');
    assert.equal(got.length, 1);
    assert.equal(got[0].assert_key, 'sig-4c93ec7045c9b');
    assert.equal(got[0].occurrences, 1);
  });

  it('re-asserting a live key adds NO row and increments occurrences', () => {
    const pebblDir = freshStore();
    runLogCli(pebblDir, [MESS, '--key', 'sig-dup']);
    const r = runLogCli(pebblDir, [MESS, '--key', 'sig-dup']);
    assert.equal(r.exitCode, 0, r.stderr);
    const got = rows(pebblDir, 'SELECT id, occurrences FROM logs');
    assert.equal(got.length, 1, 'a re-assert must not insert a second row');
    assert.equal(got[0].occurrences, 2);
  });

  it('re-asserting does NOT append a second markdown block', () => {
    const pebblDir = freshStore();
    runLogCli(pebblDir, [MESS, '--key', 'sig-md']);
    const after1 = fs.readFileSync(path.join(pebblDir, 'manual-logs.md'), 'utf8');
    runLogCli(pebblDir, [MESS, '--key', 'sig-md']);
    const after2 = fs.readFileSync(path.join(pebblDir, 'manual-logs.md'), 'utf8');
    assert.equal(after2, after1, 'dedup that still grows the .md is cosmetic');
  });

  it('collapses the measured 46-copy case to one row', () => {
    const pebblDir = freshStore();
    for (let i = 0; i < 46; i++) {
      runLogCli(pebblDir, [MESS, '--key', 'sig-46']);
    }
    const got = rows(pebblDir, 'SELECT occurrences FROM logs');
    assert.equal(got.length, 1, '46 asserts of one key must be one row');
    assert.equal(got[0].occurrences, 46, 'the count must survive so recurrence can read it');
  });

  it('different keys do not collide', () => {
    const pebblDir = freshStore();
    runLogCli(pebblDir, [MESS, '--key', 'sig-a']);
    runLogCli(pebblDir, [MESS, '--key', 'sig-b']);
    const got = rows(pebblDir, 'SELECT assert_key FROM logs ORDER BY assert_key');
    assert.deepEqual(got.map(r => r.assert_key), ['sig-a', 'sig-b']);
  });

  it('WITHOUT --key, two identical messages still produce two rows', () => {
    const pebblDir = freshStore();
    runLogCli(pebblDir, [MESS]);
    runLogCli(pebblDir, [MESS]);
    const got = rows(pebblDir, 'SELECT id FROM logs');
    assert.equal(got.length, 2, 'dedup must never leak into the keyless default path');
  });

  it('a superseded key is free again — identity is scoped to LIVE beliefs', () => {
    const pebblDir = freshStore();
    runLogCli(pebblDir, [MESS, '--key', 'sig-live']);
    const [first] = rows(pebblDir, 'SELECT id FROM logs');
    // Supersede it through the real path (--corrects stamps valid_to).
    runLogCli(pebblDir, [
      'the mess was root-caused and the custodian no longer re-emits it, because prevention graduated',
      '--corrects', String(first.id),
    ]);
    const live = rows(pebblDir, 'SELECT id FROM logs WHERE id = ? AND valid_to IS NOT NULL', first.id);
    assert.equal(live.length, 1, 'precondition: the keyed row is superseded');
    // Asserting the key again must INSERT, not resurrect a dead row's count.
    runLogCli(pebblDir, [MESS, '--key', 'sig-live']);
    const keyed = rows(
      pebblDir,
      'SELECT id, occurrences, valid_to FROM logs WHERE assert_key = ? ORDER BY id',
      'sig-live',
    );
    assert.equal(keyed.length, 2, 'a dead key must not absorb a new assert');
    assert.equal(keyed[0].occurrences, 1, "the superseded row's count is frozen");
    assert.equal(keyed[1].occurrences, 1);
    assert.equal(keyed[1].valid_to, null);
  });
});

describe('R4 outcome — failure memory', () => {
  it('persists --outcome failed', () => {
    const pebblDir = freshStore();
    const r = runLogCli(pebblDir, [
      'tried raising the collision-guard token threshold to 3 and it did not reduce false positives',
      '--outcome', 'failed',
    ]);
    assert.equal(r.exitCode, 0, r.stderr);
    const [row] = rows(pebblDir, 'SELECT outcome FROM logs');
    assert.equal(row.outcome, 'failed');
  });

  it('persists --outcome worked', () => {
    const pebblDir = freshStore();
    runLogCli(pebblDir, [
      'dropping single-token matches from the collision guard cut false positives, because one token is not duplication',
      '--outcome', 'worked',
    ]);
    const [row] = rows(pebblDir, 'SELECT outcome FROM logs');
    assert.equal(row.outcome, 'worked');
  });

  it('refuses an unknown outcome instead of storing it', () => {
    const pebblDir = freshStore();
    const r = runLogCli(pebblDir, ['an entry whose outcome value is nonsense, because it must be refused', '--outcome', 'maybe']);
    assert.notEqual(r.exitCode, 0, 'an unknown outcome must be refused');
    assert.match(r.stderr, /outcome/i);
    assert.equal(rows(pebblDir, 'SELECT id FROM logs').length, 0, 'a refused log must write nothing');
  });

  it('combines with --key: a re-asserted failure keeps its outcome and counts up', () => {
    const pebblDir = freshStore();
    const msg = 'tried widening the readback stopword list and the guard still over-triggered on json';
    runLogCli(pebblDir, [msg, '--key', 'sig-tried-stopwords', '--outcome', 'failed']);
    runLogCli(pebblDir, [msg, '--key', 'sig-tried-stopwords', '--outcome', 'failed']);
    const got = rows(pebblDir, 'SELECT occurrences, outcome FROM logs');
    assert.equal(got.length, 1);
    assert.equal(got[0].occurrences, 2);
    assert.equal(got[0].outcome, 'failed');
  });
});

describe('R4 readback consumer — a failed precedent reaches the builder', () => {
  it('carries outcome on the precedent so "tried, did not work" is visible', () => {
    const pebblDir = freshStore();
    // A durable, reasoning-category entry so readback treats it as a precedent.
    runLogCli(pebblDir, [
      'tried making src/capabilities/probe.ts sign the verdict inside Deno and it did not hold, '
      + 'because the harness must originate the probe across the kernel boundary',
      '--cat', 'correction', '--tier', 'foundation', '--outcome', 'failed',
    ]);
    const results = readback._internal.computeReadback(
      pebblDir,
      'change src/capabilities/probe.ts so the verdict is signed',
      { top: 5 },
    );
    assert.ok(results.length > 0, 'precondition: readback found the precedent');
    assert.ok(
      Object.prototype.hasOwnProperty.call(results[0], 'outcome'),
      'readback results must expose outcome',
    );
    assert.equal(results[0].outcome, 'failed');
  });

  it('leaves outcome null on a precedent that never recorded one', () => {
    const pebblDir = freshStore();
    runLogCli(pebblDir, [
      'decided src/capabilities/probe.ts keeps the harness-originated probe, because forging must fail to compile',
      '--cat', 'decision', '--tier', 'foundation',
    ]);
    const results = readback._internal.computeReadback(
      pebblDir,
      'change src/capabilities/probe.ts so the verdict is signed',
      { top: 5 },
    );
    assert.ok(results.length > 0);
    assert.equal(results[0].outcome, null);
  });
});

describe('R4 fold parity — the event log and the db move together', () => {
  it("folds a reassert into the live row's occurrences", () => {
    const events = [
      {
        eid: '01KVW2G7T0CZHJ3EV66MCAASRN',
        ts: '2026-07-30T00:00:00.000Z',
        type: 'append',
        actor: 'test',
        category: 'steering',
        tier: 'component',
        message: MESS,
        topics: ['loom'],
        assert_key: 'sig-fold',
        occurrences: 1,
      },
      {
        eid: '01KVW2G7T0CZHJ3EV66MCAASRP',
        ts: '2026-07-30T01:00:00.000Z',
        type: 'reassert',
        actor: 'test',
        assert_key: 'sig-fold',
      },
    ];
    const { logs } = foldFull(events);
    const keyed = logs.filter(r => r.assert_key === 'sig-fold');
    assert.equal(keyed.length, 1, 'a reassert must not emit a second row');
    assert.equal(keyed[0].occurrences, 2);
  });

  it('ignores a reassert whose key has no live row (dangling, never crashes)', () => {
    const events = [
      {
        eid: '01KVW2G7T0CZHJ3EV66MCAASRQ',
        ts: '2026-07-30T02:00:00.000Z',
        type: 'reassert',
        actor: 'test',
        assert_key: 'sig-nobody',
      },
    ];
    const { logs } = foldFull(events);
    assert.equal(logs.length, 0, 'a dangling reassert folds to nothing, not an error');
  });

  it('a stream with NO assert events folds byte-identically to before', () => {
    const events = [{
      eid: '01KVW2G7T0CZHJ3EV66MCAASRR',
      ts: '2026-07-30T03:00:00.000Z',
      type: 'append',
      actor: 'test',
      category: 'decision',
      tier: 'component',
      message: 'an ordinary entry with no identity key, because the additive-fold guarantee must hold',
      topics: ['loom'],
    }];
    const { logs } = foldFull(events);
    assert.equal(logs.length, 1);
    // Present-only: an event without the fields produces a row without them.
    assert.equal(Object.prototype.hasOwnProperty.call(logs[0], 'assert_key'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(logs[0], 'occurrences'), false);
  });
});
