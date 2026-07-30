'use strict';
// Compaction rollups must never be offered as readback precedents.
//
// THE MEASURED PROBLEM (eval/readback-recall/BASELINE.md): on a 261-row snapshot
// of loom's store, 8 of 10 eval queries returned a compaction ROLLUP at rank 1.
// Rollups are 5 of 261 rows but run 25k-185k characters against a 1034-char
// median entry. A row holding a quarter of accumulated text shares tokens with
// nearly any query, so bm25 puts it first and buries the specific precedent
// readback exists to surface. Removing them lifted artifact-named recall@1 from
// 0.20 to 1.00 on a corpus three times larger.
//
// WHY EXCLUSION IS THE RIGHT SHAPE, not a ranking penalty: readback's contract is
// "resume or supersede this prior work, do not rebuild it." A rollup is the
// COMPACTOR'S OWN OUTPUT — a storage artifact joining many unrelated facts. There
// is nothing in it a builder can resume and nothing they can supersede, so it can
// never satisfy that contract and has no business being returned at all.
//
// THE CONTRACT THESE TESTS FREEZE:
//   (a) ONE definition of "this row is a rollup", shared by every reader. The
//       codebase already says so in rubric.js's comment ("there is one definition
//       of 'this row is a rollup'") while testing the prefix inline; this makes
//       that literally true.
//   (b) computeReadback never returns a rollup row.
//   (c) a real precedent that a rollup was outranking now surfaces.
//   (d) rollups stay SEARCHABLE — this narrows what readback offers as a
//       precedent, it does not hide history.
//   (e) rubric's atomicity exemption for rollups is unchanged.
//
// WHY EACH TEST BITES (what to neuter to make it go red):
//   - drop the filter in loadReasoningRows      -> (b) and (c) go red
//   - make the predicate match everything       -> (c) goes red (real row vanishes)
//   - make the predicate case-sensitive         -> (a) goes red
//   - route search through the same filter      -> (d) goes red
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readback = require('../src/readback');
const { isRollupMessage } = require('../src/fold');
const { atomicityOf, loadRubric } = require('../src/rubric');

let dirs = [];
function tmpStore(events) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-rollup-'));
  dirs.push(d);
  const pebblDir = path.join(d, '.pebbl');
  fs.mkdirSync(pebblDir);
  fs.writeFileSync(
    path.join(pebblDir, 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  return pebblDir;
}
after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// The specific precedent a builder actually wants back. It describes the defect
// in prose and never names the file, which is the ordinary case.
const REAL = {
  eid: '01KVXNJVEG20XBKKAX9S4AHX4N',
  ts: '2026-07-28T10:00:00.000Z',
  type: 'append',
  actor: 'test',
  category: 'decision',
  tier: 'component',
  message: 'the maintenance cursor must fail closed and quarantine when its file is corrupt, '
    + 'because a silently reset cursor makes the encode step write twice',
  topics: ['loom'],
};

// A rollup: the compactor's own output, joining many unrelated facts. Because it
// accumulates a quarter of text it ends up naming EVERY file in the corpus, so it
// trips readback's artifact path for any spec that names any of them.
//
// This fixture reproduces the MEASURED mechanism, not just "it is big": the
// rollup comes back flagged `collision: true` and therefore sorts ahead of the
// real precedent (collision-bearing results rank above related-only ones), while
// the entry that actually answers the question is pushed to second with
// `collision: false`. That is readback telling loom "prior work exists, do not
// rebuild" on the strength of a storage artifact — the direct link to the 100%
// collision rate on loom's self-fix lane.
const ROLLUP = {
  eid: '01KYSHS1JH60Z7M6D560A1RP98',
  ts: '2026-06-24T10:00:00.000Z',
  type: 'append',
  actor: 'test',
  category: 'decision',
  tier: 'detail',
  message: '[rollup] decision notes on loom (2026-Q3): '
    + 'src/orchestration/maintenance.ts watermark work; '
    + 'src/capabilities/queue.ts newline bug; '
    + 'src/lifecycle/pipeline.ts guard scope; '
    // Padding stands in for the real 25k-185k character rollups.
    + 'assorted compacted notes for the quarter. '.repeat(40),
  topics: ['loom'],
};

// Names a file, the way a self-fix spec does. The rollup mentions that path; the
// real precedent does not.
const QUERY = 'src/orchestration/maintenance.ts should make the cursor fail closed '
  + 'and quarantine when its file is corrupt';

describe('rollup marker — one definition, shared', () => {
  it('matches the compactor marker, case-insensitively', () => {
    assert.equal(isRollupMessage('[rollup] decision notes on loom (2026-Q3): a; b'), true);
    assert.equal(isRollupMessage('[ROLLUP] decision notes'), true);
  });

  it('does not match an ordinary entry', () => {
    assert.equal(isRollupMessage(REAL.message), false);
    assert.equal(isRollupMessage('we rolled up the numbers for the quarter'), false);
    assert.equal(isRollupMessage('a note mentioning [rollup] midway through'), false);
  });

  it('is total — null, undefined and non-strings are not rollups', () => {
    assert.equal(isRollupMessage(null), false);
    assert.equal(isRollupMessage(undefined), false);
    assert.equal(isRollupMessage(42), false);
  });
});

describe('readback excludes rollups from precedents', () => {
  it('never returns a rollup row', () => {
    const store = tmpStore([REAL, ROLLUP]);
    const results = readback._internal.computeReadback(store, QUERY, { top: 10 });
    assert.equal(
      results.some((r) => r.eid === ROLLUP.eid),
      false,
      'a rollup is a storage artifact, not a precedent anyone can resume',
    );
  });

  it('surfaces the real precedent the rollup was outranking', () => {
    const store = tmpStore([REAL, ROLLUP]);
    const results = readback._internal.computeReadback(store, QUERY, { top: 10 });
    assert.ok(results.length > 0, 'the real precedent must still come back');
    assert.equal(results[0].eid, REAL.eid);
  });

  it('leaves a rollup-free corpus completely unchanged', () => {
    const withRollup = tmpStore([REAL, ROLLUP]);
    const without = tmpStore([REAL]);
    const a = readback._internal.computeReadback(withRollup, QUERY, { top: 10 });
    const b = readback._internal.computeReadback(without, QUERY, { top: 10 });
    assert.deepEqual(a.map((r) => r.eid), b.map((r) => r.eid));
  });
});

describe('rollups stay findable — this narrows precedents, not history', () => {
  it('search still returns a rollup', () => {
    const store = tmpStore([REAL, ROLLUP]);
    const rows = require('../src/fold').fold(require('../src/events').readEvents(store));
    // The fold — what `pebbl search` and `pebbl context` read — must still carry
    // the rollup. Only readback's precedent set is narrowed.
    assert.equal(rows.some((r) => r.eid === ROLLUP.eid), true, 'the rollup must remain in the store');
  });
});

describe('rubric keeps its rollup exemption through the shared predicate', () => {
  it('does not flag a rollup as non-atomic', () => {
    const store = tmpStore([REAL]);
    const rules = loadRubric(store);
    const got = atomicityOf(rules, ROLLUP.message);
    assert.equal(got.nonAtomic, false, 'a rollup is multi-fact by construction and never flagged');
  });
});
