'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { _internal } = require('../src/doctor');
const {
  detectContradictions,
  detectStaleness,
  detectMissing,
  detectHandoffHealth,
  detectNonAtomic,
  atomicityMetrics,
  diagnose,
  toJson,
  contentTerms,
  jaccard,
  pairKey,
} = _internal;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-doctor-'));
// A current belief by default: valid_to is implied NULL (the DB query filters
// it; the pure detectors never see superseded rows, so fixtures are all current).
const entry = (o) => ({
  id: 1,
  tier: 'detail',
  category: 'decision',
  timestamp: '2026-06-10T00:00:00Z',
  message: 'x',
  topics: '',
  relates_to: null,
  corrects: null,
  ...o,
});

// ── shared helpers ───────────────────────────────────────────────────────────

describe('doctor - helpers', () => {
  it('contentTerms splits a message into normalized distinct tokens', () => {
    assert.deepEqual([...contentTerms('Threshold is 0.5! threshold THRESHOLD')].sort(),
      ['0', '5', 'is', 'threshold']);
  });
  it('jaccard is 1 for identical sets, 0 for disjoint', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
    assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  });
  it('pairKey is order-independent', () => {
    assert.equal(pairKey(3, 7), pairKey(7, 3));
  });
});

// ── detector 1: contradictions ───────────────────────────────────────────────

describe('doctor - detectContradictions', () => {
  it('flags two unlinked current entries on a shared topic with high overlap', () => {
    const entries = [
      entry({ id: 1, timestamp: '2026-01-01T00:00:00Z', topics: 'auth',
        message: 'the auth threshold is 0.2 because it is conservative' }),
      entry({ id: 2, timestamp: '2026-06-01T00:00:00Z', topics: 'auth',
        message: 'the auth threshold is 0.5 because it is conservative' }),
    ];
    const out = detectContradictions(entries, { overlap: 0.5, cap: 5, minTerms: 3 });
    assert.equal(out.length, 1);
    // The OLDER entry (#1) is marked the likely-superseded one.
    assert.equal(out[0].older.id, 1);
    assert.equal(out[0].newer.id, 2);
    assert.ok(out[0].sharedTopics.includes('auth'));
  });

  it('does NOT flag a pair already linked via corrects', () => {
    const entries = [
      entry({ id: 1, timestamp: '2026-01-01T00:00:00Z', topics: 'auth',
        message: 'the auth threshold is 0.2 because it is conservative' }),
      entry({ id: 2, timestamp: '2026-06-01T00:00:00Z', topics: 'auth', corrects: 1,
        message: 'the auth threshold is 0.5 because it is conservative' }),
    ];
    assert.equal(detectContradictions(entries, { overlap: 0.5, cap: 5, minTerms: 3 }).length, 0);
  });

  it('does NOT flag entries that share no topic', () => {
    const entries = [
      entry({ id: 1, topics: 'auth', message: 'the threshold is 0.2 because conservative' }),
      entry({ id: 2, topics: 'billing', message: 'the threshold is 0.5 because conservative' }),
    ];
    assert.equal(detectContradictions(entries, { overlap: 0.5, cap: 5, minTerms: 3 }).length, 0);
  });

  it('respects the cap', () => {
    const mk = (id) => entry({ id, topics: 'auth',
      message: `the auth threshold is 0.${id} because it is conservative and tuned` });
    const entries = [mk(1), mk(2), mk(3), mk(4)];
    const out = detectContradictions(entries, { overlap: 0.5, cap: 1, minTerms: 3 });
    assert.equal(out.length, 1);
  });

  it('never mutates the input entries', () => {
    const entries = [
      entry({ id: 1, topics: 'auth', message: 'the auth threshold is 0.2 conservative' }),
      entry({ id: 2, topics: 'auth', message: 'the auth threshold is 0.5 conservative' }),
    ];
    const before = JSON.stringify(entries);
    detectContradictions(entries, {});
    assert.equal(JSON.stringify(entries), before);
  });
});

// ── detector 2: staleness ─────────────────────────────────────────────────────

describe('doctor - detectStaleness', () => {
  const now = '2026-06-20T00:00:00Z';

  it('flags an old un-reinforced component/detail entry', () => {
    const entries = [
      entry({ id: 1, tier: 'component', topics: 'legacy', timestamp: '2025-01-01T00:00:00Z',
        message: 'the legacy importer runs nightly' }),
    ];
    const out = detectStaleness(entries, { horizonDays: 180, cap: 3, now });
    assert.equal(out.length, 1);
    assert.equal(out[0].entry.id, 1);
  });

  it('does NOT flag if a newer entry on the same topic reinforces it', () => {
    const entries = [
      entry({ id: 1, tier: 'component', topics: 'legacy', timestamp: '2025-01-01T00:00:00Z',
        message: 'the legacy importer runs nightly' }),
      entry({ id: 2, tier: 'detail', topics: 'legacy', timestamp: '2026-06-01T00:00:00Z',
        message: 'legacy importer still nightly, confirmed' }),
    ];
    assert.equal(detectStaleness(entries, { horizonDays: 180, cap: 3, now }).length, 0);
  });

  it('excludes foundation (durable by design) and fleeting (noise)', () => {
    const entries = [
      entry({ id: 1, tier: 'foundation', topics: 'core', timestamp: '2024-01-01T00:00:00Z',
        message: 'uses sqlite for the store' }),
      entry({ id: 2, tier: 'fleeting', topics: 'core', timestamp: '2024-01-01T00:00:00Z',
        message: 'tmp note about the store' }),
    ];
    assert.equal(detectStaleness(entries, { horizonDays: 180, cap: 3, now }).length, 0);
  });

  it('does NOT flag a recent entry', () => {
    const entries = [
      entry({ id: 1, tier: 'detail', topics: 'legacy', timestamp: now,
        message: 'the legacy importer runs nightly' }),
    ];
    assert.equal(detectStaleness(entries, { horizonDays: 180, cap: 3, now }).length, 0);
  });
});

// ── detector 3: missing artifact (reuses check.js) ────────────────────────────

describe('doctor - detectMissing (reuses check.js)', () => {
  it('flags an entry citing a file that does not exist; spares the present one', () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/present.js'), 'x');
    const entries = [
      entry({ id: 1, message: 'uses src/present.js for X' }),
      entry({ id: 2, message: 'the gone src/missing.js does Y' }),
    ];
    const out = detectMissing(entries, repo, {});
    assert.equal(out.length, 1);
    assert.equal(out[0].entry.id, 2);
    assert.deepEqual(out[0].entry.missingPaths, ['src/missing.js']);
  });

  it('spares a cross-repo entry whose cited file exists in the repo it NAMES', () => {
    // The loom false-positive shape: an entry logged in THIS store about
    // ANOTHER repo ("repo /abs/path") citing that repo's relative paths.
    const store = tmp();                 // doctor's repoRoot — file not here
    const other = tmp();                 // the named repo — file lives here
    fs.mkdirSync(path.join(other, 'src'));
    fs.writeFileSync(path.join(other, 'src/lib.rs'), 'x');
    const entries = [
      entry({ id: 1, message: `HAROLD (repo ${other}, Rust): core in src/lib.rs` }),
      entry({ id: 2, message: `HAROLD (repo ${other}, Rust): gone src/nope.rs` }),
    ];
    const out = detectMissing(entries, store, {});
    assert.equal(out.length, 1, 'only the nowhere-existing citation is flagged');
    assert.equal(out[0].entry.id, 2);
  });
});

// ── detector 4: handoff health (lifecycle) ────────────────────────────────────

describe('doctor - detectHandoffHealth', () => {
  const now = '2026-06-22T00:00:00Z';
  const ho = (o) => ({ id: 1, timestamp: now, summary: 'real work summary', status: 'open', ...o });

  it('flags a MALFORMED open handoff (bare number)', () => {
    const out = detectHandoffHealth([ho({ id: 7, summary: '4' })], { openDays: 14, cap: 10, now });
    assert.equal(out.length, 1);
    assert.equal(out[0].handoff.id, 7);
    assert.ok(out[0].malformed, 'carries a malformed reason');
  });

  it('flags a LONG-OPEN handoff (open past the threshold)', () => {
    const out = detectHandoffHealth(
      [ho({ id: 3, timestamp: '2026-05-01T00:00:00Z' })], // ~52d before now
      { openDays: 14, cap: 10, now });
    assert.equal(out.length, 1);
    assert.equal(out[0].handoff.id, 3);
    assert.equal(out[0].malformed, null);
    assert.ok(out[0].longOpen);
    assert.ok(out[0].ageDays >= 14);
  });

  it('does NOT flag a recent, well-formed open handoff', () => {
    const out = detectHandoffHealth([ho({ id: 1, timestamp: now })], { openDays: 14, cap: 10, now });
    assert.equal(out.length, 0);
  });

  it('does NOT flag a CLOSED handoff even if old/malformed', () => {
    const out = detectHandoffHealth(
      [ho({ id: 9, summary: '5', status: 'closed', timestamp: '2026-01-01T00:00:00Z' })],
      { openDays: 14, cap: 10, now });
    assert.equal(out.length, 0);
  });

  it('respects the cap and sorts malformed before merely-old', () => {
    const handoffs = [
      ho({ id: 1, timestamp: '2026-05-01T00:00:00Z' }),        // old, well-formed
      ho({ id: 2, summary: '12', timestamp: now }),            // malformed, recent
      ho({ id: 3, timestamp: '2026-04-01T00:00:00Z' }),        // older, well-formed
    ];
    const out = detectHandoffHealth(handoffs, { openDays: 14, cap: 2, now });
    assert.equal(out.length, 2);
    assert.ok(out[0].malformed, 'malformed sorts first');
    assert.equal(out[0].handoff.id, 2);
  });
});

// ── detector 5: non-atomic entries (multi-topic) ──────────────────────────────

describe('doctor - detectNonAtomic', () => {
  // A slice of the rubric: an entry that trips >=3 of these is non-atomic.
  const rules = [
    { pattern: new RegExp('chose|decided', 'i'), category: 'decision', tier: 'component' },
    { pattern: new RegExp('module|component|boundary', 'i'), category: 'structure', tier: 'component' },
    { pattern: new RegExp('schema|model|table', 'i'), category: 'data', tier: 'detail' },
    { pattern: new RegExp('api|endpoint', 'i'), category: 'integration', tier: 'detail' },
  ];

  it('flags an entry that matches >= 3 categories, with the matched categories', () => {
    const entries = [
      entry({ id: 1, message: 'chose to refactor the auth module and migrate the schema' }),
    ];
    const out = detectNonAtomic(entries, rules, {});
    assert.equal(out.length, 1);
    assert.equal(out[0].entry.id, 1);
    assert.deepEqual(out[0].categories, ['decision', 'structure', 'data']);
  });

  it('does NOT flag an atomic single-topic entry', () => {
    const out = detectNonAtomic([entry({ id: 1, message: 'chose SQLite over Postgres' })], rules, {});
    assert.equal(out.length, 0);
  });

  it('does NOT flag a 2-category entry under 300 chars, but DOES once it exceeds 300', () => {
    const short = 'chose to refactor the module'; // decision + structure, < 300 chars
    assert.equal(detectNonAtomic([entry({ id: 1, message: short })], rules, {}).length, 0);
    const long = short + ' '.repeat(310) + 'end';   // same 2 categories, > 300 chars
    const out = detectNonAtomic([entry({ id: 2, message: long })], rules, {});
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].categories, ['decision', 'structure']);
  });

  it('returns nothing when no rubric rules are supplied', () => {
    assert.equal(detectNonAtomic([entry({ id: 1, message: 'chose to refactor the module schema' })], []).length, 0);
  });

  it('is report-only: never mutates the input entries', () => {
    const entries = [entry({ id: 1, message: 'chose to refactor the module and change the schema' })];
    const before = JSON.stringify(entries);
    detectNonAtomic(entries, rules, {});
    assert.equal(JSON.stringify(entries), before);
  });

  it('surfaces in diagnose/toJson with a split hint, and diagnose changes nothing', () => {
    const repo = tmp();
    const entries = [
      entry({ id: 1, message: 'chose to refactor the auth module and migrate the schema' }),
      entry({ id: 2, message: 'chose SQLite over Postgres' }), // atomic — not flagged
    ];
    const snapshot = JSON.stringify(entries);
    const r = diagnose(entries, repo, { now: '2026-06-20T00:00:00Z', rules });
    assert.equal(r.nonatomic.length, 1);
    assert.equal(r.nonatomic[0].entry.id, 1);
    // report-only: the store/entries are untouched after a full diagnose pass.
    assert.equal(JSON.stringify(entries), snapshot);

    const hit = toJson(r).find(c => c.dimension === 'nonatomic');
    assert.ok(hit, 'a nonatomic candidate is emitted');
    assert.deepEqual(hit.ids, [1]);
    assert.match(hit.reason, /3 categories/);
    assert.match(hit.suggested, /split #1/);
  });
});

// ── compose + clean-store + json ──────────────────────────────────────────────

describe('doctor - diagnose (composition)', () => {
  it('clean store: every dimension empty', () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/a.js'), 'x');
    const entries = [
      entry({ id: 1, tier: 'foundation', topics: 'core', timestamp: '2026-06-19T00:00:00Z',
        message: 'uses src/a.js as the entry point' }),
    ];
    const r = diagnose(entries, repo, { now: '2026-06-20T00:00:00Z' });
    assert.equal(r.contradictions.length, 0);
    assert.equal(r.staleness.length, 0);
    assert.equal(r.missing.length, 0);
    assert.equal(toJson(r).length, 0);
  });

  it('a malformed open handoff surfaces in the json contract with a close hint', () => {
    const repo = tmp();
    const r = diagnose([], repo, {
      now: '2026-06-22T00:00:00Z',
      handoffs: [{ id: 7, timestamp: '2026-06-22T00:00:00Z', summary: '4', status: 'open' }],
    });
    assert.equal(r.handoffs.length, 1);
    const json = toJson(r);
    const hit = json.find(c => c.dimension === 'handoff');
    assert.ok(hit, 'a handoff candidate is emitted');
    assert.deepEqual(hit.ids, [7]);
    assert.match(hit.reason, /malformed/);
    assert.match(hit.suggested, /pebbl handoff --close 7/);
  });

  it('clean store with no handoffs: handoff dimension empty', () => {
    const repo = tmp();
    const r = diagnose([], repo, { now: '2026-06-22T00:00:00Z' }); // no opts.handoffs
    assert.equal(r.handoffs.length, 0);
  });

  it('known contradiction surfaces in the json contract', () => {
    const repo = tmp();
    const entries = [
      entry({ id: 1, timestamp: '2026-01-01T00:00:00Z', topics: 'auth',
        message: 'the auth threshold is 0.2 because it is conservative' }),
      entry({ id: 2, timestamp: '2026-06-01T00:00:00Z', topics: 'auth',
        message: 'the auth threshold is 0.5 because it is conservative' }),
    ];
    const r = diagnose(entries, repo, { contradictionOverlap: 0.5, now: '2026-06-20T00:00:00Z' });
    const json = toJson(r);
    const hit = json.find(c => c.dimension === 'contradiction');
    assert.ok(hit, 'a contradiction candidate is emitted');
    assert.deepEqual(hit.ids.sort(), [1, 2]);
    assert.match(hit.suggested, /pebbl log ".*" --corrects 1/);
  });
});

// ── atomicity scoreboard (the quantitative metric) ────────────────────────────

describe('doctor - atomicityMetrics (pure)', () => {
  // A rubric slice: a session rule (-> uncategorized/fleeting) plus content
  // rules, so the fixture exercises every code path (multi-fact, atomic, session
  // primary=uncategorized, and a match-nothing entry).
  const rules = [
    { pattern: new RegExp('^\\[session\\]', 'i'), category: 'uncategorized', tier: 'fleeting' },
    { pattern: new RegExp('chose|decided', 'i'), category: 'decision', tier: 'component' },
    { pattern: new RegExp('module|component|boundary', 'i'), category: 'structure', tier: 'component' },
    { pattern: new RegExp('schema|model|table', 'i'), category: 'data', tier: 'detail' },
    { pattern: new RegExp('api|endpoint', 'i'), category: 'integration', tier: 'detail' },
  ];

  // Known mix:
  //  #1 decision+structure+data  = 3 cats -> NON-ATOMIC, bucket 3+
  //  #2 decision                 = 1 cat  -> atomic,      bucket 1
  //  #3 structure                = 1 cat  -> atomic,      bucket 1
  //  #4 [session] + 4 content    = 5 cats -> scoped out (primary uncategorized), bucket 3+
  //  #5 no rule matches          = 0 cats -> atomic,      bucket 0, uncategorized
  const entries = [
    entry({ id: 1, message: 'chose to refactor the auth module and migrate the schema' }),
    entry({ id: 2, message: 'chose SQLite over Postgres' }),
    entry({ id: 3, message: 'refactored the auth module' }),
    entry({ id: 4, message: '[session] chose to refactor the module and migrate the schema and wire the api' }),
    entry({ id: 5, message: 'random free-form note with none of the keywords here' }),
  ];

  it('computes total, non-atomic count+rate, mean, distribution, and uncategorized rate', () => {
    const m = atomicityMetrics(entries, rules);
    assert.equal(m.total, 5);
    // only #1 is non-atomic (#4 is scoped out as a session log): 1/5 = 20%.
    assert.deepEqual(m.nonAtomic, { count: 1, rate: 20 });
    // categories per entry: 3 + 1 + 1 + 5 + 0 = 10; 10/5 = 2.0.
    assert.equal(m.meanCategories, 2);
    assert.deepEqual(m.distribution, { '0': 1, '1': 2, '2': 0, '3plus': 2 });
    // #4 (primary uncategorized) + #5 (matched nothing) = 2/5 = 40%.
    assert.equal(m.uncategorizedRate, 40);
  });

  it('rates round to one decimal', () => {
    // 1 of 3 non-atomic = 33.333… -> 33.3.
    const three = [
      entry({ id: 1, message: 'chose to refactor the auth module and migrate the schema' }), // 3 cats
      entry({ id: 2, message: 'chose SQLite over Postgres' }),                                 // 1 cat
      entry({ id: 3, message: 'refactored the auth module' }),                                 // 1 cat
    ];
    assert.equal(atomicityMetrics(three, rules).nonAtomic.rate, 33.3);
  });

  it('an empty store is all-zeros and never divides by zero', () => {
    const m = atomicityMetrics([], rules);
    assert.deepEqual(m, {
      total: 0,
      nonAtomic: { count: 0, rate: 0 },
      meanCategories: 0,
      distribution: { '0': 0, '1': 0, '2': 0, '3plus': 0 },
      uncategorizedRate: 0,
    });
  });

  it('with no rubric rules every entry has 0 categories and is uncategorized', () => {
    const m = atomicityMetrics(entries, []);
    assert.equal(m.total, 5);
    assert.deepEqual(m.nonAtomic, { count: 0, rate: 0 });
    assert.equal(m.meanCategories, 0);
    assert.deepEqual(m.distribution, { '0': 5, '1': 0, '2': 0, '3plus': 0 });
    assert.equal(m.uncategorizedRate, 100);
  });

  it('is report-only: never mutates the input entries', () => {
    const before = JSON.stringify(entries);
    atomicityMetrics(entries, rules);
    assert.equal(JSON.stringify(entries), before);
  });
});

// ── `pebbl doctor --metrics` end-to-end (drives the real CLI) ─────────────────

describe('pebbl doctor --metrics (CLI)', () => {
  const BIN = path.resolve(__dirname, '../bin/pebbl.js');
  const dirs = [];
  const project = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-metrics-'));
    dirs.push(d);
    fs.mkdirSync(path.join(d, '.pebbl'));
    return d;
  };
  const run = (dir, args) => spawnSync('node', [BIN, ...args], { cwd: dir, encoding: 'utf8' });

  // Seed a known mix via the REAL log path so the default rubric classifies it:
  //  - ATOMIC      -> decision (1 cat)
  //  - NON-ATOMIC  -> decision+structure+data (3 cats, the headline flag)
  //  - SESSION     -> primary uncategorized, scoped out of non-atomic
  //  - NO-MATCH    -> 0 categories, uncategorized
  function seed(dir) {
    assert.equal(run(dir, ['log', 'chose SQLite over Postgres']).status, 0);
    assert.equal(run(dir, ['log', 'chose to refactor the auth module and migrate the schema to a new table']).status, 0);
    assert.equal(run(dir, ['log', '[session] chose to refactor the module and migrate the schema and wire the api']).status, 0);
    assert.equal(run(dir, ['log', 'just some free-form prose with none of the keywords present']).status, 0);
  }

  it('--json returns the documented shape with correct numbers', () => {
    const dir = project();
    seed(dir);
    const r = run(dir, ['doctor', '--metrics', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const m = JSON.parse(r.stdout);
    // documented keys present
    assert.deepEqual(Object.keys(m).sort(),
      ['distribution', 'meanCategories', 'nonAtomic', 'total', 'uncategorizedRate']);
    assert.equal(m.total, 4);
    assert.deepEqual(m.nonAtomic, { count: 1, rate: 25 });       // 1 of 4
    assert.deepEqual(m.distribution, { '0': 1, '1': 1, '2': 0, '3plus': 2 });
    // (1 + 3 + 5 + 0) / 4 = 2.25 -> 2.3
    assert.equal(m.meanCategories, 2.3);
    // session (primary uncategorized) + no-match = 2 of 4 = 50%
    assert.equal(m.uncategorizedRate, 50);
  });

  it('human output is the compact scoreboard and SHORT-CIRCUITS the detector report', () => {
    const dir = project();
    seed(dir);

    // Sanity: a plain `doctor` DOES surface the non-atomic section here.
    const plain = run(dir, ['doctor']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /Non-atomic entries —/);

    const r = run(dir, ['doctor', '--metrics']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /atomicity scoreboard \(4 current entries\)/);
    assert.match(r.stdout, /non-atomic:\s+1 \/ 4\s+\(25\.0%\)/);
    assert.match(r.stdout, /uncategorized:\s+50\.0%/);
    // short-circuit: none of the 4 detector sections nor the summary line print.
    assert.doesNotMatch(r.stdout, /candidate(s)? to review/);
    assert.doesNotMatch(r.stdout, /Non-atomic entries —/);
    assert.doesNotMatch(r.stdout, /Contradictions —/);
    assert.doesNotMatch(r.stdout, /Handoffs —/);
  });

  const { after } = require('node:test');
  after(() => {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });
});
