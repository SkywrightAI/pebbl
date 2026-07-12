'use strict';
// fold/db id-drift regression — the loom-store incident (2026-07-12). The real
// drift shape: log-commit.js (the post-commit capture hook) INSERTed logs rows
// into db.sqlite WITHOUT appending an event, so db.sqlite's AUTOINCREMENT ids
// ran ahead of the fold's renumbered ids. compact's old POSITIONAL int->eid map
// then (a) silently resolved every later row to the WRONG eid and (b) dropped
// the top ids with "no event eid ... (fold/db id drift)" — leaving those rows
// permanently un-compactable. Two halves under test here:
//   1. compact resolves eids by row IDENTITY (timestamp+message), so a store
//      with a phantom db-only row still compacts every real row, no warning.
//   2. log-commit now appends the event alongside the db row, so new phantom
//      rows stop being created (the drift's write-path root cause).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const { readEvents } = require('../src/events');
const { fold } = require('../src/fold');
const { buildRowEidResolver } = require('../src/compact');

const NODE = process.execPath;
const HERMETIC_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

// Throwaway git repo + initialized store, same shape compact-append-only uses.
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-id-drift-'));
  const env = { ...process.env, PATH: HERMETIC_PATH };
  const run = (args) => execFileSync(NODE, [BIN, ...args], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const runCapture = (args) => spawnSync(NODE, [BIN, ...args], { cwd: dir, env, encoding: 'utf8' });
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  run(['init']);
  return { dir, run, runCapture };
}

// Mimic the PRE-FIX log-commit write: a logs row in db.sqlite with NO event —
// the exact phantom that shifted every later AUTOINCREMENT id off the fold's.
function insertPhantomRow(dir) {
  const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'));
  try {
    db.prepare(`
      INSERT INTO logs (timestamp, source, category, tier, message, topics)
      VALUES (?, 'hook', 'uncategorized', 'fleeting', ?, NULL)
    `).run(new Date().toISOString(), 'phantom commit capture (db-only, no event)');
  } finally {
    db.close();
  }
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('compact - fold/db id-drift repair (identity eid resolution)', () => {
  it('compacts a drifted store (phantom db-only row) with no drift warning and the RIGHT membership', () => {
    const { dir, run, runCapture } = freshStore();
    try {
      // 2 filler rows first, then the phantom, then the 12-row rollup group —
      // so every group row's db id sits +1 ahead of its fold id, and the last
      // group row's db id has NO fold counterpart at all (the loom shape).
      run(['log', 'filler note one about miscellany', '--cat', 'quality', '--tier', 'detail', '--topic', 'misc']);
      run(['log', 'filler note two about miscellany', '--cat', 'quality', '--tier', 'detail', '--topic', 'misc']);
      insertPhantomRow(dir);
      for (let i = 1; i <= 12; i++) {
        run(['log', `widget note ${i} for the system`, '--cat', 'data', '--tier', 'detail', '--topic', 'widgets']);
      }

      // Sanity: the drift exists — db ids run ahead of the fold's row count.
      const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
      const maxId = db.prepare('SELECT MAX(id) mx FROM logs').get().mx;
      db.close();
      const foldRows = fold(readEvents(path.join(dir, '.pebbl')));
      assert.equal(maxId, 15, 'db.sqlite: 2 filler + 1 phantom + 12 group rows');
      assert.equal(foldRows.length, 14, 'fold: the phantom row has no event');

      const res = runCapture(['compact', '--execute']);
      assert.equal(res.status, 0, `compact must exit 0 (stderr: ${res.stderr})`);
      assert.ok(
        !/no event eid/.test(res.stderr) && !/no event eid/.test(res.stdout),
        `drifted rows must resolve by identity, not warn+skip (got: ${res.stderr})`
      );

      // Exactly one supersede rolling up ALL 12 group rows — under the old
      // positional map the membership was wrong (11 rows, one of them a filler
      // eid) and the last group row was skipped.
      const events = readEvents(path.join(dir, '.pebbl'));
      const supersedes = events.filter((e) => e.type === 'supersede');
      assert.equal(supersedes.length, 1, 'one rollup group -> one supersede');
      assert.equal(supersedes[0].rolls_up.length, 12, 'ALL 12 group rows rolled up despite the drift');

      // The fold agrees: one rollup row, zero surviving group rows, and the
      // filler rows untouched (they were never mismapped into the rollup).
      const rows = fold(events);
      const msgs = rows.map((r) => r.message);
      assert.equal(msgs.filter((m) => /^\[rollup\]/.test(m)).length, 1);
      assert.equal(msgs.filter((m) => /^widget note \d+/.test(m)).length, 0, 'group rows hidden');
      assert.equal(msgs.filter((m) => /^filler note/.test(m)).length, 2, 'filler rows survive');
    } finally {
      cleanup(dir);
    }
  });

  it('resolves exact-duplicate (ts,message) rows to DISTINCT eids in fold order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-id-drift-dup-'));
    try {
      const pebblDir = path.join(dir, '.pebbl');
      fs.mkdirSync(pebblDir);
      const ts = '2026-07-08T08:37:39.219Z';
      const ev = (eid) => JSON.stringify({
        eid, ts, emitted_at: ts, type: 'append', actor: 't@t', v: 1,
        category: 'data', tier: 'detail', message: 'same signal twice', topics: ['t'],
      });
      fs.writeFileSync(path.join(pebblDir, 'events.jsonl'), ev('01AAA') + '\n' + ev('01BBB') + '\n');
      const resolve = buildRowEidResolver(pebblDir);
      const row = { id: 1, timestamp: ts, message: 'same signal twice' };
      const first = resolve(row);
      const second = resolve({ ...row, id: 2 });
      assert.deepEqual([first, second].sort(), ['01AAA', '01BBB'], 'two rows, two distinct eids');
      assert.equal(resolve({ ...row, id: 3 }), null, 'a third identical row has no event left to claim');
    } finally {
      cleanup(dir);
    }
  });
});

describe('log-commit - the drift write path appends the event too', () => {
  it('a captured commit lands in BOTH db.sqlite and events.jsonl (source hook, fleeting)', () => {
    const { dir, run } = freshStore();
    try {
      run(['log-commit', 'abc1234def5678', 'fix: capture commits into events too', 'src/a.js,src/b.js,']);

      // db row, as before.
      const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
      const row = db.prepare("SELECT source, tier, message FROM logs WHERE source = 'hook'").get();
      db.close();
      assert.ok(row, 'commit-capture logs row exists in db.sqlite');
      assert.equal(row.tier, 'fleeting');
      assert.equal(row.message, 'fix: capture commits into events too');

      // NEW: the matching event — no more db-only phantom rows.
      const events = readEvents(path.join(dir, '.pebbl'));
      const appended = events.find((e) => e.type === 'append' && e.message === 'fix: capture commits into events too');
      assert.ok(appended, 'the commit-capture row has an append event');
      assert.equal(appended.source, 'hook', 'the event carries source=hook (fold keeps the label on rebuild)');
      assert.equal(appended.tier, 'fleeting');

      // Alignment holds: db.sqlite ids and the fold agree again.
      const db2 = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
      const n = db2.prepare('SELECT COUNT(*) n, MAX(id) mx FROM logs').get();
      db2.close();
      const foldRows = fold(events);
      assert.equal(n.mx, foldRows.length, 'no phantom: db max id == fold row count');
      assert.equal(foldRows.find((r) => r.message === row.message).source, 'hook', 'folded row keeps source=hook');
    } finally {
      cleanup(dir);
    }
  });
});
