'use strict';
// Rebuild preservation — the commits-table half of the fold/db drift incident.
// compaction's rebuildReadModelFromEvents overwrites db.sqlite from the events
// fold, so anything with no event was DESTROYED by a rebuild: the commits
// table (git post-commit capture wrote db-only rows), handoffs (still a
// db-only write path), and legacy phantom logs rows. The loom store lost every
// captured commit this way on 2026-07-12. Three guarantees under test:
//   1. log-commit now emits a `commit` event and the fold reduces it into the
//      commits projection, so a captured commit SURVIVES compaction (and is
//      not double-minted by the backfill).
//   2. A commits row that PREDATES event-backed capture (db-only, no event)
//      is backfilled into events.jsonl at rebuild time and survives too.
//   3. The same backfill preserves live phantom logs rows and handoffs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const { readEvents } = require('../src/events');
const { foldFull } = require('../src/fold');

const NODE = process.execPath;
const HERMETIC_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-commit-preserved-'));
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

// A compactable group so `compact --execute` actually appends a batch and
// triggers the rebuild (the destructive step under test).
function fillCompactableGroup(run) {
  for (let i = 1; i <= 12; i++) {
    run(['log', `widget note ${i} for the system`, '--cat', 'data', '--tier', 'detail', '--topic', 'widgets']);
  }
}

function commitsRows(dir) {
  const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT timestamp, hash, message, files FROM commits ORDER BY id').all();
  } finally {
    db.close();
  }
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('commit capture survives a rebuild-from-events', () => {
  it('log-commit emits a commit event; compaction keeps the commits row + commit-log.md line', () => {
    const { dir, run, runCapture } = freshStore();
    try {
      run(['log-commit', 'abc1234def5678', 'fix: keep captured commits alive', 'src/a.js,src/b.js,']);
      fillCompactableGroup(run);

      // The capture minted exactly one commit event alongside the append.
      const before = readEvents(path.join(dir, '.pebbl')).filter((e) => e.type === 'commit');
      assert.equal(before.length, 1, 'one commit event per captured commit');
      assert.equal(before[0].hash, 'abc1234def5678');
      assert.equal(before[0].files, 'src/a.js,src/b.js', 'trailing comma stripped, same as the db row');

      const res = runCapture(['compact', '--execute']);
      assert.equal(res.status, 0, `compact must exit 0 (stderr: ${res.stderr})`);

      // The rebuild regenerated db.sqlite FROM events — the commit survives.
      const rows = commitsRows(dir);
      assert.equal(rows.length, 1, 'commits table survives the rebuild');
      assert.equal(rows[0].hash, 'abc1234def5678');
      assert.equal(rows[0].message, 'fix: keep captured commits alive');

      // Not double-minted: the backfill recognized the existing commit event.
      const after = readEvents(path.join(dir, '.pebbl')).filter((e) => e.type === 'commit');
      assert.equal(after.length, 1, 'backfill mints nothing for an already-evented commit');

      // The regenerated projection still names the commit.
      const md = fs.readFileSync(path.join(dir, '.pebbl', 'commit-log.md'), 'utf8');
      assert.match(md, /abc1234d: fix: keep captured commits alive/, 'commit-log.md regenerated with the capture');
    } finally {
      cleanup(dir);
    }
  });

  it('a pre-event commits row (db-only) is backfilled at rebuild time and survives', () => {
    const { dir, run, runCapture } = freshStore();
    try {
      // Mimic the PRE-FIX capture: a commits row with NO commit event — the
      // exact rows the loom incident destroyed.
      const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'));
      db.prepare('INSERT INTO commits (timestamp, hash, message, files) VALUES (?,?,?,?)')
        .run('2026-07-01T10:00:00.000Z', 'feedbeef1234', 'feat: legacy capture with no event', 'src/x.js');
      db.close();
      fillCompactableGroup(run);

      const res = runCapture(['compact', '--execute']);
      assert.equal(res.status, 0, `compact must exit 0 (stderr: ${res.stderr})`);
      assert.match(res.stderr, /backfilled 1 commit/, 'the backfill is loud, not silent');

      const rows = commitsRows(dir);
      assert.equal(rows.length, 1, 'the pre-event commit survives the rebuild');
      assert.equal(rows[0].hash, 'feedbeef1234');

      // And it is now event-backed, so the NEXT rebuild needs no backfill.
      const commitEvents = readEvents(path.join(dir, '.pebbl')).filter((e) => e.type === 'commit');
      assert.equal(commitEvents.length, 1, 'a commit event was minted for the legacy row');
      assert.equal(commitEvents[0].hash, 'feedbeef1234');
    } finally {
      cleanup(dir);
    }
  });

  it('a live phantom logs row and a handoff survive the rebuild too', () => {
    const { dir, run, runCapture } = freshStore();
    try {
      // Phantom logs row (db-only, no event) — the id-drift incident shape.
      const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'));
      db.prepare(`
        INSERT INTO logs (timestamp, source, category, tier, message, topics, valid_from)
        VALUES (?, 'hook', 'quality', 'detail', ?, 'phantoms', ?)
      `).run('2026-07-01T09:00:00.000Z', 'phantom row that must survive the rebuild', '2026-07-01T09:00:00.000Z');
      db.close();
      // Handoffs are a db-only write path — the rebuild used to wipe them.
      run(['handoff', 'wiring the widget cache', '--done', 'cache keys chosen', '--todo', 'invalidate on write']);
      fillCompactableGroup(run);

      const res = runCapture(['compact', '--execute']);
      assert.equal(res.status, 0, `compact must exit 0 (stderr: ${res.stderr})`);

      const rdb = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
      const phantom = rdb.prepare("SELECT source, tier, topics FROM logs WHERE message = 'phantom row that must survive the rebuild'").get();
      const handoff = rdb.prepare('SELECT summary, done, todo, status FROM handoffs').get();
      rdb.close();

      assert.ok(phantom, 'phantom logs row survives (minted as an append event)');
      assert.equal(phantom.source, 'hook', 'phantom keeps its source');
      assert.ok(handoff, 'handoff survives the rebuild');
      assert.equal(handoff.summary, 'wiring the widget cache');
      assert.equal(handoff.done, 'cache keys chosen');
      assert.equal(handoff.status, 'open');

      // Both are event-backed now — folding events alone reproduces them.
      const projection = foldFull(readEvents(path.join(dir, '.pebbl')));
      assert.ok(projection.logs.find((r) => r.message === 'phantom row that must survive the rebuild'));
      assert.equal(projection.handoffs.length, 1);
    } finally {
      cleanup(dir);
    }
  });
});
