'use strict';
// Fail-closed write path — the OTHER half of the fold/db id-drift fix. The
// identity resolver (compact.js) TOLERATES a phantom db-only row; this pins
// that `pebbl log` can no longer CREATE one: when the events.jsonl append
// fails, the freshly-inserted db row (and the corrects stamp, and the .md
// projection line) are rolled back and the command exits non-zero, so
// db.sqlite and events.jsonl never diverge. A failure AFTER the physical
// append (a derived-view rebuild error) must do the opposite — keep both
// sides, warn, exit 0 — because rolling back a db row whose event landed
// would create the same drift in the other direction.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const { readEvents } = require('../src/events');

const NODE = process.execPath;
const HERMETIC_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

// Throwaway git repo + initialized store, same shape compact-id-drift uses.
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-fail-closed-'));
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

// Force the append itself to fail: a DIRECTORY where events.jsonl should be
// makes both the torn-line repair (openSync r+) and appendFileSync throw
// EISDIR — deterministically, before any event line can land.
function blockEventsFile(dir) {
  const p = path.join(dir, '.pebbl', 'events.jsonl');
  fs.rmSync(p, { force: true });
  fs.mkdirSync(p);
}

function logCount(dir) {
  const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) n FROM logs').get().n;
  } finally {
    db.close();
  }
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('log - fail-closed on event-append failure (no orphan db row)', () => {
  it('rolls back the db row and the .md line, exits non-zero', () => {
    const { dir, runCapture } = freshStore();
    try {
      const mdPath = path.join(dir, '.pebbl', 'manual-logs.md');
      const mdBefore = fs.readFileSync(mdPath, 'utf8');
      const rowsBefore = logCount(dir);
      blockEventsFile(dir);

      const res = runCapture(['log', 'a note that must not half-land', '--cat', 'quality', '--tier', 'detail']);
      assert.notEqual(res.status, 0, 'a failed event append must exit non-zero');
      assert.match(res.stderr, /entry NOT stored/, 'the caller is told the entry was not stored');

      // No orphan db row survives — this is the phantom the id-drift incident
      // was made of.
      assert.equal(logCount(dir), rowsBefore, 'no db row survives the failed append');
      assert.equal(fs.readFileSync(mdPath, 'utf8'), mdBefore, 'manual-logs.md is byte-identical (entry truncated back out)');
    } finally {
      cleanup(dir);
    }
  });

  it('rolls back the corrects stamp too — the prior belief stays current', () => {
    const { dir, run, runCapture } = freshStore();
    try {
      run(['log', 'the widget cache lives in redis', '--cat', 'decision', '--tier', 'component', '--topic', 'widgets']);
      blockEventsFile(dir);

      const res = runCapture(['log', 'the widget cache moved to sqlite', '--corrects', '1']);
      assert.notEqual(res.status, 0, 'the failed correction exits non-zero');

      const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
      const target = db.prepare('SELECT valid_to, invalidated_by FROM logs WHERE id = 1').get();
      const n = db.prepare('SELECT COUNT(*) n FROM logs').get().n;
      db.close();
      assert.equal(n, 1, 'the correcting row was rolled back');
      assert.equal(target.valid_to, null, 'target un-stamped: still the current belief');
      assert.equal(target.invalidated_by, null, 'target un-stamped: no dangling invalidated_by');
    } finally {
      cleanup(dir);
    }
  });

  it('a failure AFTER the append (derived-view rebuild) keeps BOTH sides aligned, exit 0', () => {
    const { dir, runCapture } = freshStore();
    try {
      // events-view.md as a directory breaks rebuildEventsView's writeFileSync
      // — a post-append, derived-projection failure. The event has landed by
      // then, so the db row must be KEPT (rolling it back would manufacture
      // the opposite drift: an event with no row).
      const viewMd = path.join(dir, '.pebbl', 'events-view.md');
      fs.rmSync(viewMd, { force: true });
      fs.mkdirSync(viewMd);

      const res = runCapture(['log', 'a note whose view rebuild fails', '--cat', 'quality', '--tier', 'detail']);
      assert.equal(res.status, 0, `post-append projection failure must not fail the write (stderr: ${res.stderr})`);
      assert.match(res.stderr, /view rebuild skipped/, 'the skipped rebuild is warned, not silent');

      assert.equal(logCount(dir), 1, 'the db row is kept');
      const events = readEvents(path.join(dir, '.pebbl'));
      const appended = events.filter((e) => e.type === 'append' && e.message === 'a note whose view rebuild fails');
      assert.equal(appended.length, 1, 'the event is on disk — db and events stay in lockstep');
    } finally {
      cleanup(dir);
    }
  });
});
