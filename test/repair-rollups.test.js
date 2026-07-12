'use strict';
// repair-rollups — append-only repair for the id-drift MIS-ROLL (the loom
// incident, 2026-07-12): a compaction run with the old positional int->eid map
// recorded a rolls_up membership shifted off the group the rollup TEXT was
// built from. Wrongly-suppressed neighbors vanished from the live view;
// escaped true members stayed live next to a rollup that already carried
// their content. The repair detects the mismatch by row identity (the member
// messages are embedded verbatim in the rollup text), restores the suppressed
// entries as fresh append events (with a restores:<eid> audit field) and
// hides the escaped duplicates with expire events — never rewriting history.

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
const { isMemberSegment, analyzeRollups } = require('../src/repair-rollups');

const NODE = process.execPath;
const HERMETIC_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-repair-rollups-'));
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

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function quarterOf(ts) {
  return `${ts.slice(0, 4)}-Q${Math.ceil(parseInt(ts.slice(5, 7), 10) / 3)}`;
}

// Reproduce the incident: 4 neighbor entries + 8 group entries, then a
// hand-crafted supersede whose TEXT names the true group (g1..g8) but whose
// rolls_up eids are SHIFTED to [n1..n4, g1..g4] — so n1..n4 are wrongly
// suppressed and g5..g8 escape.
function seedMisRolledStore() {
  const store = freshStore();
  const { dir, run } = store;
  for (let i = 1; i <= 4; i++) {
    run(['log', `neighbor note ${i} about miscellany`, '--cat', 'quality', '--tier', 'detail', '--topic', 'misc']);
  }
  for (let i = 1; i <= 8; i++) {
    run(['log', `widget group note ${i} for the system`, '--cat', 'data', '--tier', 'detail', '--topic', 'widgets']);
  }

  const pebblDir = path.join(dir, '.pebbl');
  const events = readEvents(pebblDir);
  const appendOf = (msg) => events.find((e) => e.type === 'append' && e.message === msg);
  const neighbors = [1, 2, 3, 4].map((i) => appendOf(`neighbor note ${i} about miscellany`));
  const group = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => appendOf(`widget group note ${i} for the system`));

  const rollupMessage = `[rollup] data notes on widgets (${quarterOf(group[0].ts)}): ${group.map((g) => g.message).join('; ')}.`;
  const now = new Date().toISOString();
  const supersede = {
    eid: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', // sorts last; only uniqueness matters
    ts: now,
    emitted_at: now,
    type: 'supersede',
    actor: 't@t',
    v: 1,
    rolls_up: [...neighbors.map((n) => n.eid), ...group.slice(0, 4).map((g) => g.eid)],
    category: 'data',
    tier: 'detail',
    message: rollupMessage,
    topics: 'misc,widgets',
  };
  fs.appendFileSync(path.join(pebblDir, 'events.jsonl'), JSON.stringify(supersede) + '\n');
  return { ...store, pebblDir, neighbors, group, supersede };
}

describe('repair-rollups - member-segment matcher', () => {
  const text = '[rollup] data notes on widgets (2026-Q3): alpha beta; gamma; semi; colon tail; last one.';
  it('matches whole member segments only', () => {
    assert.equal(isMemberSegment(text, 'alpha beta'), true, 'first member (after ": ")');
    assert.equal(isMemberSegment(text, 'gamma'), true, 'middle member');
    assert.equal(isMemberSegment(text, 'last one'), true, 'final member (before the closing ".")');
    assert.equal(isMemberSegment(text, 'semi; colon tail'), true, 'a member containing "; " still matches whole');
    assert.equal(isMemberSegment(text, 'alpha'), false, 'a substring of a member is NOT a member');
    assert.equal(isMemberSegment(text, 'beta; gamma'), false, 'a span straddling two members is NOT a member');
    assert.equal(isMemberSegment(text, ''), false, 'empty never matches');
  });
  it('strips the [rollup] prefix off a rollup-of-a-rollup candidate', () => {
    assert.equal(isMemberSegment(text, '[rollup] gamma'), true);
  });
  it('follows content through NESTED rollups (stacked close-dots)', () => {
    // An earlier rollup "...: aa; bb." embedded as a member of a later one:
    // its final member "bb" now sits before ".." (inner dot + outer dot), and
    // before ".; " when the inner rollup lands mid-list.
    const nestedTail = '[rollup] data notes on t (2026-Q3): x; data notes on t (2026-Q2): aa; bb..';
    assert.equal(isMemberSegment(nestedTail, 'bb'), true, 'final member of the inner rollup, at the outer end');
    assert.equal(isMemberSegment(nestedTail, 'aa'), true, 'mid member of the inner rollup');
    const nestedMid = '[rollup] data notes on t (2026-Q3): data notes on t (2026-Q2): aa; bb.; y.';
    assert.equal(isMemberSegment(nestedMid, 'bb'), true, 'inner-final member mid-list (".; ")');
    assert.equal(isMemberSegment(nestedMid, 'y'), true, 'outer member after the nested one');
    // But a member whose stored text merely STARTS with the candidate still
    // does not match — dots are the only characters the boundary consumes.
    assert.equal(isMemberSegment('[rollup] d notes on t (2026-Q3): alpha. beta.', 'alpha'), false);
  });
});

describe('repair-rollups - the mis-rolled store (loom incident shape)', () => {
  it('dry-run diagnoses the shift and writes nothing', () => {
    const { dir, pebblDir, runCapture } = seedMisRolledStore();
    try {
      const before = fs.readFileSync(path.join(pebblDir, 'events.jsonl'), 'utf8');
      const res = runCapture(['repair-rollups']);
      assert.equal(res.status, 0, `dry-run exits 0 (stderr: ${res.stderr})`);
      assert.match(res.stdout, /DRY-RUN/);
      assert.match(res.stdout, /WRONGLY SUPPRESSED — 4/, '4 neighbors flagged for restore');
      assert.match(res.stdout, /ESCAPED DUPLICATES — 4/, '4 escaped group members flagged for expire');
      assert.equal(fs.readFileSync(path.join(pebblDir, 'events.jsonl'), 'utf8'), before, 'dry-run writes nothing');
    } finally {
      cleanup(dir);
    }
  });

  it('--apply restores the suppressed neighbors and hides the escaped duplicates, append-only', () => {
    const { dir, pebblDir, runCapture, neighbors, supersede } = seedMisRolledStore();
    try {
      const res = runCapture(['repair-rollups', '--apply']);
      assert.equal(res.status, 0, `apply exits 0 (stderr: ${res.stderr})`);
      assert.match(res.stdout, /Repaired: restored 4, hidden 4/);

      const events = readEvents(pebblDir);
      // Append-only: the bogus supersede is still on record, untouched.
      assert.ok(events.find((e) => e.eid === supersede.eid), 'history not rewritten');
      // Each restore names the entry it resurrects.
      const restores = events.filter((e) => e.type === 'append' && e.restores);
      assert.equal(restores.length, 4);
      for (const n of neighbors) {
        const r = restores.find((e) => e.restores === n.eid);
        assert.ok(r, `restore for ${n.eid}`);
        assert.equal(r.message, n.message, 'restored message is the original');
        assert.equal(r.ts, n.ts, 'restored ts keeps the timeline slot');
      }

      const rows = fold(events);
      const msgs = rows.filter((r) => r.valid_to == null).map((r) => r.message);
      assert.equal(msgs.filter((m) => /^neighbor note \d/.test(m)).length, 4, 'all 4 neighbors live again');
      assert.equal(msgs.filter((m) => /^widget group note \d/.test(m)).length, 0, 'no group member (escaped or rolled) is live');
      assert.equal(msgs.filter((m) => /^\[rollup\]/.test(m)).length, 1, 'the rollup row stays');

      // The rebuilt canonical db agrees with the fold.
      const db = new Database(path.join(pebblDir, 'db.sqlite'), { readonly: true });
      const liveNeighbors = db.prepare("SELECT COUNT(*) n FROM logs WHERE message LIKE 'neighbor note %' AND valid_to IS NULL").get().n;
      const liveWidgets = db.prepare("SELECT COUNT(*) n FROM logs WHERE message LIKE 'widget group note %'").get().n;
      db.close();
      assert.equal(liveNeighbors, 4);
      assert.equal(liveWidgets, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('is idempotent: a second run plans nothing and writes nothing', () => {
    const { dir, pebblDir, runCapture } = seedMisRolledStore();
    try {
      assert.equal(runCapture(['repair-rollups', '--apply']).status, 0);
      const before = fs.readFileSync(path.join(pebblDir, 'events.jsonl'), 'utf8');
      const res = runCapture(['repair-rollups', '--apply']);
      assert.equal(res.status, 0);
      assert.match(res.stdout, /nothing to write/i, 'live state already consistent');
      assert.equal(fs.readFileSync(path.join(pebblDir, 'events.jsonl'), 'utf8'), before, 'second apply appends nothing');
    } finally {
      cleanup(dir);
    }
  });

  it('a clean store reports nothing to repair', () => {
    const { dir, run, runCapture } = freshStore();
    try {
      for (let i = 1; i <= 12; i++) {
        run(['log', `widget note ${i} for the system`, '--cat', 'data', '--tier', 'detail', '--topic', 'widgets']);
      }
      assert.equal(runCapture(['compact', '--execute']).status, 0, 'an honest compaction');
      const res = runCapture(['repair-rollups']);
      assert.equal(res.status, 0);
      assert.match(res.stdout, /nothing to repair/, 'correct membership -> no findings');
    } finally {
      cleanup(dir);
    }
  });
});

describe('repair-rollups - analyzeRollups guards (pure)', () => {
  it('does not expire a duplicate logged AFTER the rollup (ts guard)', () => {
    const base = '2026-07-01T10:00:00.000Z';
    const rollTs = '2026-07-02T10:00:00.000Z';
    const late = '2026-07-03T10:00:00.000Z';
    const ev = (eid, ts, message) => ({ eid, ts, emitted_at: ts, type: 'append', actor: 't', v: 1, category: 'data', tier: 'detail', message, topics: ['t'] });
    const events = [
      ev('01AAA', base, 'the same recurring signal'),
      { eid: '01SSS', ts: rollTs, emitted_at: rollTs, type: 'supersede', actor: 't', v: 1, rolls_up: ['01AAA'], category: 'data', tier: 'detail', message: '[rollup] data notes on t (2026-Q3): the same recurring signal.', topics: 't' },
      ev('01BBB', late, 'the same recurring signal'), // NEW information, post-rollup
    ];
    const { restores, expires } = analyzeRollups(events);
    assert.equal(restores.length, 0, 'the rolled-up original is represented in the text');
    assert.equal(expires.length, 0, 'a post-rollup duplicate is new signal, never expired');
  });
});
