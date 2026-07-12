'use strict';
// P3 — compaction is append-only. These tests REPLACE the deleted
// archiveEntries / archive.md assertions: instead of asserting the destructive
// transaction archived rows before deleting them, they assert the inversion —
// compaction only APPENDS supersede/resolve/expire events to events.jsonl
// (zero git deletions), the originals stay in the log, and the fold hides them
// from the live view while surfacing the rollup. No archive/*.txt, no
// archive.md, no db.transaction.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const { readEvents } = require('../src/events');
const { fold } = require('../src/fold');

// Launch the child with an absolute node and a minimal PATH that still has git
// (/usr/bin) but nothing from the user's shell, so the test runs in a fixed,
// hermetic environment regardless of what's installed on the machine.
const NODE = process.execPath;
const HERMETIC_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

// The first test commits inside the store repo; the post-commit capture hook
// would append a commit-capture event and skew the 12-append arithmetic, so
// capture is disabled for this file (children inherit the env). Capture is
// covered by test/compact-id-drift.test.js.
process.env.PEBBL_SKIP_CAPTURE = '1';

// Spin up a throwaway git repo with a populated, REAL (categorized, topic'd)
// pebbl store so buildGroups finds a rollup group. Flags use the names pebbl
// log actually knows: --cat / --tier / --topic (NOT --category/--topics).
function populatedStore(n = 12) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-append-only-'));
  const env = { ...process.env, PATH: HERMETIC_PATH };
  const run = (args) => execFileSync(NODE, [BIN, ...args], { cwd: dir, env, stdio: ['ignore', 'pipe', 'ignore'] });
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  run(['init']);
  for (let i = 1; i <= n; i++) {
    run(['log', `widget note ${i} for the system`, '--cat', 'data', '--tier', 'detail', '--topic', 'widgets']);
  }
  return { dir, run, git };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('compact - append-only (P3 event-sourcing flip)', () => {
  it('compact --execute appends a supersede event and deletes NOTHING from events.jsonl', () => {
    const { dir, run, git } = populatedStore(12);
    try {
      // Force-track events.jsonl: a default `pebbl init` is LOCAL (the whole
      // .pebbl/ is gitignored, leak-proof default), so we add it with -f to
      // measure the diff. The append-only PROPERTY is independent of whether the
      // store is shared; --shared is P5's surface.
      const evRel = '.pebbl/events.jsonl';
      git(['add', '-f', evRel]);
      git(['commit', '-qm', 'base']);
      const before = fs.readFileSync(path.join(dir, evRel), 'utf8').split('\n').filter(Boolean).length;

      run(['compact', '--execute']);

      git(['add', '-f', evRel]);
      const diff = execFileSync('git', ['diff', '--cached', '--', evRel], { cwd: dir, encoding: 'utf8' });
      const deletions = diff.split('\n').filter((l) => /^-[^-]/.test(l)).length;
      const additions = diff.split('\n').filter((l) => /^\+[^+]/.test(l)).length;
      const after = fs.readFileSync(path.join(dir, evRel), 'utf8').split('\n').filter(Boolean).length;

      assert.equal(deletions, 0, 'compaction must delete ZERO lines from events.jsonl');
      assert(additions > 0, 'compaction must append at least one event');
      assert(after > before, 'the log only grows');

      // The appended event is a supersede whose rolls_up names the 12 sources.
      const events = readEvents(path.join(dir, '.pebbl'));
      const supersedes = events.filter((e) => e.type === 'supersede');
      assert.equal(supersedes.length, 1, 'one rollup -> one supersede event');
      assert.equal(supersedes[0].rolls_up.length, 12, 'all 12 sources rolled up by eid');
      assert.match(supersedes[0].message, /^\[rollup\]/);

      // The 12 original append events still sit in the log (nothing deleted).
      assert.equal(events.filter((e) => e.type === 'append').length, 12);
    } finally {
      cleanup(dir);
    }
  });

  it('the fold hides the rolled-up sources and surfaces exactly one rollup row', () => {
    const { dir, run } = populatedStore(12);
    try {
      run(['compact', '--execute']);
      const rows = fold(readEvents(path.join(dir, '.pebbl')));
      const messages = rows.map((r) => r.message);
      const rollups = messages.filter((m) => /^\[rollup\]/.test(m));
      assert.equal(rollups.length, 1, 'exactly one live rollup row');
      // None of the raw source messages survive as their own live row.
      const sourcesStillLive = messages.filter((m) => /^widget note \d+ for the system$/.test(m));
      assert.equal(sourcesStillLive.length, 0, 'rolled-up sources are hidden from the live view');
    } finally {
      cleanup(dir);
    }
  });

  it('writes NO archive artifacts (events.jsonl is the durable archive)', () => {
    const { dir, run } = populatedStore(12);
    try {
      run(['compact', '--execute']);
      assert.equal(fs.existsSync(path.join(dir, '.pebbl', 'archive')), false, 'no archive/ dir');
      assert.equal(fs.existsSync(path.join(dir, '.pebbl', 'archive.md')), false, 'no archive.md');
    } finally {
      cleanup(dir);
    }
  });

  it('--resolve id:foundation appends a resolve event (no in-place UPDATE)', () => {
    const { dir, run } = populatedStore(0);
    try {
      // One uncategorized entry becomes ambiguous; resolve it to foundation.
      run(['log', 'an ambiguous unresolved note about stuff']);
      run(['compact', '--execute', '--resolve', '1:foundation']);
      const events = readEvents(path.join(dir, '.pebbl'));
      const resolves = events.filter((e) => e.type === 'resolve');
      assert.equal(resolves.length, 1, 'one --resolve foundation -> one resolve event');
      assert.equal(resolves[0].tier, 'foundation');
      assert(resolves[0].target, 'resolve carries the target eid');
      // The fold lifts that entry to foundation tier.
      const rows = fold(events);
      const lifted = rows.find((r) => r.eid === resolves[0].target);
      assert(lifted && lifted.tier === 'foundation', 'resolve re-tiers the targeted entry to foundation');
    } finally {
      cleanup(dir);
    }
  });

  it('the fold dedups two overlapping supersedes, keeping the lexicographically-smaller eid', () => {
    // Two supersede events sharing a rolls_up eid (concurrent / double
    // compaction). The fold keeps the smaller supersede eid and drops the
    // other's rollup row, so it is "ugly not broken" — one live rollup.
    const ev = [
      { eid: '01A', ts: '2026-01-01T00:00:00Z', emitted_at: '2026-01-01T00:00:00Z', type: 'append', message: 'src1', category: 'detail', tier: 'detail', topics: 't' },
      { eid: '01B', ts: '2026-01-01T00:00:01Z', emitted_at: '2026-01-01T00:00:01Z', type: 'append', message: 'src2', category: 'detail', tier: 'detail', topics: 't' },
      { eid: '02Z', ts: '2026-01-02T00:00:00Z', emitted_at: '2026-01-02T00:00:00Z', type: 'supersede', rolls_up: ['01A', '01B'], message: '[rollup] r1', category: 'detail', tier: 'detail', topics: 't' },
      { eid: '02A', ts: '2026-01-02T00:00:00Z', emitted_at: '2026-01-02T00:00:00Z', type: 'supersede', rolls_up: ['01A', '01B'], message: '[rollup] dup', category: 'detail', tier: 'detail', topics: 't' },
    ];
    const rows = fold(ev);
    const msgs = rows.map((r) => r.message);
    const rollups = msgs.filter((m) => /^\[rollup\]/.test(m));
    assert.equal(rollups.length, 1, 'one deduped rollup, not two');
    assert(!msgs.includes('src1') && !msgs.includes('src2'), 'sources hidden by supersede');
    // The kept rollup is the one minted by the smaller supersede eid (02A < 02Z).
    assert.equal(rollups[0], '[rollup] dup');
  });
});
