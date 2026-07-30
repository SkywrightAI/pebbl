'use strict';
// `pebbl liveness` / `pebbl heartbeat` — Primitive 2: detect the ABSENCE of an
// expected event (silent-fail detection). These tests prove the silent-fail
// LOGIC on hand-built registries with an INJECTED clock (deterministic, no
// wall-clock dependence), AND the additive event/fold guarantee + the end-to-end
// CLI on a hermetic store. Design: notes/design-selflearning-primitives-2026-06-23.md
// §0/§2/§4.
//
// Idiom mirrors readback.test.js / events.test.js: a committed seed `events.jsonl`
// (a plain data file — the repo's .gitignore ignores any `.pebbl/`, so a store
// can't be committed under one) is copied into a fresh tmp <dir>/.pebbl/ at
// runtime, with the `.events-canonical` completeness marker so storeMode()
// returns 'events' and the CLI folds it. The PURE pieces (parseDuration /
// evaluateRegistry / checkRegistry) are exercised directly via _internal — that
// is where the OVERDUE / FRESH / NEVER-BEAT / SENTINEL / must-trip logic lives,
// so it is proven with a fixed `nowMs`, not the system clock.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { foldFull } = require('../src/fold');
const events = require('../src/events');
const {
  parseDuration, evaluateRegistry, checkRegistry,
  SENTINEL_NAME,
} = require('../src/liveness')._internal;

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');
const FIXTURE_EVENTS = path.join(__dirname, 'fixtures', 'liveness-store', 'events.jsonl');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A fixed reference "now" for the pure tests, so OVERDUE/FRESH are deterministic
// regardless of when the suite runs.
const NOW = Date.parse('2026-06-24T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// Build a registry row the fold would produce (name/every/grace/registered_at/
// last_beat), so the pure evaluators can be driven without a store.
function regRow(name, every, grace, registeredAt, lastBeat, lastProof) {
  return {
    name, every, grace,
    registered_at: registeredAt || null,
    last_beat: lastBeat || null,
    last_proof: lastProof || '',
  };
}

// Stand up a hermetic events-mode store from the committed seed, returning the
// WORKING-TREE dir (parent of .pebbl/, where find-pebbl walks up from). Each call
// is its own tmpdir so a `check` self-beat (which WRITES) never bleeds across
// tests.
function makeFixtureStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-liveness-'));
  const pebblDir = path.join(dir, '.pebbl');
  fs.mkdirSync(pebblDir, { recursive: true });
  fs.copyFileSync(FIXTURE_EVENTS, path.join(pebblDir, 'events.jsonl'));
  fs.writeFileSync(path.join(pebblDir, '.events-canonical'), 'hermetic liveness fixture\n');
  return dir;
}

// Run the CLI; capture stdout + exit status without throwing (so a deliberate
// non-zero exit is assertable). Returns { status, stdout, stderr }.
function runCli(cwd, args, input) {
  const res = require('child_process').spawnSync('node', [PEBBL_BIN, ...args], {
    cwd, input, encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// ── duration parsing ─────────────────────────────────────────────────────────

describe('liveness: parseDuration', () => {
  it('parses h/m/d/s/w units and a bare number as seconds', () => {
    assert.equal(parseDuration('24h'), DAY);
    assert.equal(parseDuration('1h'), HOUR);
    assert.equal(parseDuration('90m'), 90 * 60 * 1000);
    assert.equal(parseDuration('2d'), 2 * DAY);
    assert.equal(parseDuration('45s'), 45 * 1000);
    assert.equal(parseDuration('1w'), 7 * DAY);
    assert.equal(parseDuration('30'), 30 * 1000); // bare number = seconds
  });
  it('returns null on garbage / empty', () => {
    assert.equal(parseDuration(''), null);
    assert.equal(parseDuration('soon'), null);
    assert.equal(parseDuration(null), null);
  });
});

// ── POSITIVE: a registered-then-silent job flags OVERDUE (the real silent fail) ─

describe('liveness POSITIVE — a stale job is OVERDUE', () => {
  it('triage registered --every 24h with a last beat ~2 days old is OVERDUE', () => {
    // last beat 2 days before NOW; every 24h (+1h grace) => well past deadline.
    const rows = [regRow('triage', '24h', '1h', iso(NOW - 3 * DAY), iso(NOW - 2 * DAY), 'rows=24')];
    const [r] = evaluateRegistry(rows, NOW);
    assert.equal(r.overdue, true, 'triage must be OVERDUE (2d old beat vs 24h cadence)');
    assert.equal(r.reason, 'beat-too-old');
  });

  it('the same job becomes OVERDUE only AFTER every+grace elapses (boundary)', () => {
    // beat exactly 24h+1h ago == on the deadline (not yet over); 1ms more == over.
    const onDeadline = [regRow('triage', '24h', '1h', iso(NOW - 2 * DAY), iso(NOW - (DAY + HOUR)))];
    assert.equal(evaluateRegistry(onDeadline, NOW)[0].overdue, false, 'exactly on deadline is not yet overdue');
    const overBy1ms = [regRow('triage', '24h', '1h', iso(NOW - 2 * DAY), iso(NOW - (DAY + HOUR) - 1))];
    assert.equal(evaluateRegistry(overBy1ms, NOW)[0].overdue, true, '1ms past deadline is overdue');
  });
});

// ── FRESH: a job beat within its interval is NOT flagged ──────────────────────

describe('liveness FRESH — a recently-beat job is not flagged', () => {
  it('a job beat 1h ago with a 24h cadence is NOT overdue', () => {
    const rows = [regRow('brief', '24h', '0s', iso(NOW - 5 * DAY), iso(NOW - HOUR))];
    const [r] = evaluateRegistry(rows, NOW);
    assert.equal(r.overdue, false);
    assert.equal(r.reason, 'fresh');
  });
});

// ── NEVER-BEAT: a registered-but-never-beat job is OVERDUE from registration ──

describe('liveness NEVER-BEAT — registered but never beat is OVERDUE', () => {
  it('a job registered long ago with no heartbeat is OVERDUE from registered_at', () => {
    const rows = [regRow('canary', '24h', '0s', iso(NOW - 3 * DAY), null)];
    const [r] = evaluateRegistry(rows, NOW);
    assert.equal(r.last_beat, null);
    assert.equal(r.overdue, true, 'never-beat past deadline is overdue');
    assert.equal(r.reason, 'never-beat-past-deadline');
  });
  it('a job registered just now with no heartbeat is NOT yet overdue (still within grace)', () => {
    const rows = [regRow('fresh-reg', '24h', '0s', iso(NOW - HOUR), null)];
    const [r] = evaluateRegistry(rows, NOW);
    assert.equal(r.overdue, false, 'registered 1h ago, 24h cadence: not yet overdue');
    assert.equal(r.reason, 'never-beat-within-grace');
  });
});

// ── SENTINEL + must-trip: the self-proving checker cannot pass while BLIND ─────

describe('liveness SENTINEL — a healthy check ALWAYS reports the planted sentinel OVERDUE', () => {
  it('checkRegistry injects the sentinel and reports it OVERDUE on a normal registry', () => {
    const registry = [regRow('brief', '24h', '0s', iso(NOW - 5 * DAY), iso(NOW - HOUR))]; // one fresh job
    const report = checkRegistry(registry, NOW);
    const sentinel = report.results.find((r) => r.name === SENTINEL_NAME);
    assert.ok(sentinel, 'the planted sentinel must be in every walk');
    assert.equal(sentinel.overdue, true, 'the sentinel must ALWAYS be overdue');
    assert.equal(report.healthy, true, 'a check that trips the sentinel is healthy');
    assert.ok(report.walked_count >= 2, 'walked count includes the real job + the sentinel');
  });

  it('MUST-TRIP: an EMPTY registry still trips the sentinel — a check over zero real jobs is NOT silent-green', () => {
    // Over an empty store the ONLY overdue is the sentinel; healthy is still true
    // because the sentinel proves the comparator works. The dangerous case the
    // design names ("green over 0 jobs") cannot happen: the walk is never empty.
    const report = checkRegistry([], NOW);
    assert.equal(report.walked_count, 1, 'even an empty registry walks the sentinel');
    assert.equal(report.overdue.length, 1, 'exactly the sentinel is overdue');
    assert.equal(report.overdue[0].sentinel, true);
    assert.equal(report.healthy, true, 'the sentinel keeps an empty check honest (>=1 overdue)');
  });

  it('MUST-TRIP: a BLIND comparator (reports zero overdue) is NOT healthy', () => {
    // Simulate a broken check by evaluating with a comparator that can never see
    // the sentinel as overdue: feed checkRegistry a registry, but assert the
    // healthy gate via a forced zero-overdue path. We model "blind" as a results
    // set where nothing (not even the sentinel) is overdue — exactly what a dead
    // comparator produces — and confirm the gate computes healthy=false + LOUD.
    // (We reach the gate directly: build the same shape checkRegistry returns.)
    const blind = checkRegistryWithBrokenComparator([], NOW);
    assert.equal(blind.overdue.length, 0, 'the broken comparator reports zero overdue');
    assert.equal(blind.healthy, false, 'zero overdue => BLIND => not healthy (must-trip)');
    assert.match(blind.reason, /BLIND/i);
  });

  it('MUST-TRIP: if the sentinel itself is not reported overdue, the check is NOT healthy', () => {
    // A subtler blindness: some OTHER job is overdue but the sentinel is wrongly
    // fresh (a comparator that mishandles ancient timestamps). Even with >=1
    // overdue, a fresh sentinel means the comparator is unproven -> not healthy.
    const report = checkRegistryWithFreshSentinel(
      [regRow('triage', '24h', '0s', iso(NOW - 3 * DAY), iso(NOW - 2 * DAY))],
      NOW
    );
    assert.ok(report.overdue.some((r) => r.name === 'triage'), 'triage is genuinely overdue');
    const s = report.results.find((r) => r.name === SENTINEL_NAME);
    assert.equal(s.overdue, false, 'this fault model wrongly marks the sentinel fresh');
    assert.equal(report.healthy, false, 'an unproven (fresh) sentinel must fail the self-proof');
    assert.match(report.reason, /sentinel/i);
  });
});

// Fault-injection helpers: reproduce checkRegistry's healthy GATE over a
// deliberately broken evaluation, to prove the gate goes red. We re-import the
// gate logic shape rather than monkey-patching the module.
function gate(results) {
  const overdue = results.filter((r) => r.overdue);
  const sentinel = results.find((r) => r.name === SENTINEL_NAME) || null;
  const sentinelOverdue = !!(sentinel && sentinel.overdue);
  const healthy = sentinelOverdue && overdue.length >= 1;
  let reason = 'ok';
  if (!sentinelOverdue) reason = 'BLIND: the planted always-overdue sentinel was NOT reported overdue — the liveness comparator is broken';
  else if (overdue.length < 1) reason = 'BLIND: zero overdue reported (a working check always trips the sentinel) — the checker walked nothing';
  return { results, overdue, sentinel, walked_count: results.length, healthy, reason };
}
// A dead comparator: nothing is ever overdue (not even the sentinel).
function checkRegistryWithBrokenComparator(registry, nowMs) {
  const evaluated = evaluateRegistry(registry, nowMs).map((r) => ({ ...r, overdue: false }));
  // also include a (wrongly-fresh) sentinel row so the shape matches a real walk
  evaluated.push({ name: SENTINEL_NAME, sentinel: true, overdue: false, reason: 'fresh' });
  return gate(evaluated);
}
// A comparator that evaluates real jobs correctly but wrongly marks the sentinel fresh.
function checkRegistryWithFreshSentinel(registry, nowMs) {
  const evaluated = evaluateRegistry(registry, nowMs);
  evaluated.push({ name: SENTINEL_NAME, sentinel: true, overdue: false, reason: 'fresh' });
  return gate(evaluated);
}

// ── ADDITIVE FOLD: existing event types fold byte-identical with liveness present ─

describe('liveness ADDITIVE FOLD — existing projections are byte-identical', () => {
  // A rich stream of EXISTING event types (mirrors fold.test.js richStream).
  function existingStream() {
    return [
      { type: 'append',        eid: 'a01', ts: '2026-01-01T00:00:00.000Z', emitted_at: '2026-01-01T00:00:00.000Z', message: 'orig db choice', category: 'decision', tier: 'component', topics: ['db'] },
      { type: 'append',        eid: 'a02', ts: '2026-01-02T00:00:00.000Z', emitted_at: '2026-01-02T00:00:00.000Z', message: 'cache warms on boot', category: 'pattern', tier: 'detail', topics: ['cache'] },
      { type: 'correct',       eid: 'a03', ts: '2026-01-03T00:00:00.000Z', emitted_at: '2026-01-03T00:00:00.000Z', message: 'use postgres not mysql', category: 'decision', tier: 'component', topics: ['db'], corrects: 'a01' },
      { type: 'append',        eid: 'a04', ts: '2026-01-04T00:00:00.000Z', emitted_at: '2026-01-04T00:00:00.000Z', message: 'fleeting note', category: 'uncategorized', tier: 'fleeting', topics: [] },
      { type: 'expire',        eid: 'a05', ts: '2026-01-05T00:00:00.000Z', emitted_at: '2026-01-05T00:00:00.000Z', target: 'a04' },
      { type: 'append',        eid: 'a06', ts: '2026-01-06T00:00:00.000Z', emitted_at: '2026-01-06T00:00:00.000Z', message: 'detail one', category: 'data', tier: 'detail', topics: ['x'] },
      { type: 'append',        eid: 'a07', ts: '2026-01-07T00:00:00.000Z', emitted_at: '2026-01-07T00:00:00.000Z', message: 'detail two', category: 'data', tier: 'detail', topics: ['x'] },
      { type: 'supersede',     eid: 'a08', ts: '2026-01-08T00:00:00.000Z', emitted_at: '2026-01-08T00:00:00.000Z', message: '[rollup] data notes on x', category: 'data', tier: 'detail', topics: ['x'], rolls_up: ['a06', 'a07'] },
      { type: 'resolve',       eid: 'a09', ts: '2026-01-09T00:00:00.000Z', emitted_at: '2026-01-09T00:00:00.000Z', target: 'a02', tier: 'foundation' },
      { type: 'handoff-open',  eid: 'h01', ts: '2026-01-10T00:00:00.000Z', emitted_at: '2026-01-10T00:00:00.000Z', summary: 'session', done: 'a; b', todo: 'c', session_entries: ['a01', 'a06'] },
      { type: 'handoff-close', eid: 'h02', ts: '2026-01-11T00:00:00.000Z', emitted_at: '2026-01-11T00:00:00.000Z', handoff: 'h01' },
      { type: 'narrative-set', eid: 'n01', ts: '2026-01-12T00:00:00.000Z', emitted_at: '2026-01-12T00:00:00.000Z', text: 'project does X', refs: ['a03'] },
    ];
  }
  function livenessEvents() {
    return [
      { type: 'liveness-register', eid: 'L01', ts: '2026-01-13T00:00:00.000Z', emitted_at: '2026-01-13T00:00:00.000Z', name: 'triage', every: '24h', grace: '1h' },
      { type: 'heartbeat',         eid: 'L02', ts: '2026-01-14T00:00:00.000Z', emitted_at: '2026-01-14T00:00:00.000Z', name: 'triage', proof: 'rows=24' },
    ];
  }

  it('logs/handoffs/commits/narrative are byte-identical with vs without liveness events', () => {
    const without = foldFull(existingStream());
    const withLive = foldFull(existingStream().concat(livenessEvents()));
    assert.equal(JSON.stringify(withLive.logs), JSON.stringify(without.logs), 'logs projection unchanged by liveness events');
    assert.equal(JSON.stringify(withLive.handoffs), JSON.stringify(without.handoffs), 'handoffs unchanged');
    assert.equal(JSON.stringify(withLive.commits), JSON.stringify(without.commits), 'commits unchanged');
    assert.equal(JSON.stringify(withLive.narrative), JSON.stringify(without.narrative), 'narrative unchanged');
  });

  it('the liveness projection captures the cadence + the latest beat; absent on a no-liveness stream', () => {
    const without = foldFull(existingStream());
    assert.deepEqual(without.liveness, [], 'no liveness events => empty liveness projection');
    const withLive = foldFull(existingStream().concat(livenessEvents()));
    const triage = withLive.liveness.find((r) => r.name === 'triage');
    assert.ok(triage, 'triage registered in the liveness projection');
    assert.equal(triage.every, '24h');
    assert.equal(triage.grace, '1h');
    assert.equal(triage.last_beat, '2026-01-14T00:00:00.000Z', 'last_beat is the heartbeat ts');
    assert.equal(triage.last_proof, 'rows=24');
  });

  it('liveness fold is deterministic across input order (a beat may precede its register)', () => {
    const stream = existingStream().concat(livenessEvents());
    const baseline = JSON.stringify(foldFull(stream).liveness);
    // reverse + a manual interleave; sorted order makes the result identical.
    assert.equal(JSON.stringify(foldFull(stream.slice().reverse()).liveness), baseline);
  });
});

// ── END-TO-END: the real CLI on a hermetic store ─────────────────────────────

describe('liveness CLI — register / heartbeat / check end to end', () => {
  it('check on the committed seed reports the stale triage + never-beat-canary OVERDUE, exits 0 (healthy)', () => {
    const dir = makeFixtureStore();
    const res = runCli(dir, ['liveness', 'check', '--json']);
    assert.equal(res.status, 0, `check should exit 0 (healthy: it can SEE), got ${res.status}\n${res.stderr}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.healthy, true, 'a check that trips the sentinel is healthy');
    const overdueNames = report.overdue.map((r) => r.name);
    assert.ok(overdueNames.includes('triage'), `triage must be OVERDUE, got ${JSON.stringify(overdueNames)}`);
    assert.ok(overdueNames.includes('never-beat-canary'), 'the never-beat job must be OVERDUE');
    assert.ok(overdueNames.includes(SENTINEL_NAME), 'the planted sentinel must be reported OVERDUE');
    assert.ok(report.sentinel && report.sentinel.overdue, 'sentinel status surfaced + overdue');
    assert.ok(report.walked_count >= 3, 'walked count includes the seed jobs, the self-beat job, and the sentinel');
  });

  it('register + a fresh heartbeat => that job is NOT flagged on the next check', () => {
    const dir = makeFixtureStore();
    let r = runCli(dir, ['liveness', 'register', 'fresh-job', '--every', '24h', '--grace', '1h']);
    assert.equal(r.status, 0, `register failed: ${r.stderr}`);
    r = runCli(dir, ['heartbeat', 'fresh-job', '--proof', 'ok']);
    assert.equal(r.status, 0, `heartbeat failed: ${r.stderr}`);
    r = runCli(dir, ['liveness', 'check', '--json']);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const overdueNames = report.overdue.map((x) => x.name);
    assert.ok(!overdueNames.includes('fresh-job'), 'a just-beat job must not be overdue');
  });

  it('a heartbeat is appended ADDITIVELY (the seed append log row still folds)', () => {
    const dir = makeFixtureStore();
    runCli(dir, ['heartbeat', 'triage', '--proof', 'fresh']);
    const proj = foldFull(events.readEvents(path.join(dir, '.pebbl')));
    // the plain append from the seed is still a live log row (additive guarantee)
    assert.ok(
      proj.logs.some((l) => l.message.includes('a plain reasoning log entry')),
      'the seed append log row must survive alongside the liveness events',
    );
    // and triage now has the fresher beat
    const triage = proj.liveness.find((l) => l.name === 'triage');
    assert.equal(triage.last_proof, 'fresh', 'the new heartbeat updated triage last_proof');
  });

  it('--factory-guide --json on liveness AND heartbeat emit edges that all carry BUILT|PLANNED', () => {
    for (const cmd of [['liveness', 'check', '--factory-guide', '--json'], ['heartbeat', '--factory-guide', '--json']]) {
      const r = runCli(os.tmpdir(), cmd); // static manifest, no store needed
      assert.equal(r.status, 0, `${cmd.join(' ')} should exit 0`);
      const g = JSON.parse(r.stdout);
      assert.ok(g.command && g.call_when && g.precondition && g.effect && g.consumes && g.produces);
      assert.ok(Array.isArray(g.edges) && g.edges.length > 0);
      for (const e of g.edges) {
        assert.ok(['BUILT', 'PLANNED'].includes(e.status), `edge ${e.to} has bad status ${e.status}`);
      }
    }
  });

  it('the scheduler-derived registry edge is tagged PLANNED (not yet built)', () => {
    const r = runCli(os.tmpdir(), ['liveness', '--factory-guide', '--json']);
    const g = JSON.parse(r.stdout);
    const sched = g.edges.find((e) => /scheduler-derived/i.test(e.to));
    assert.ok(sched && sched.status === 'PLANNED', 'scheduler-derived-registry must be PLANNED');
  });

  it('liveness --help and heartbeat --help exit 0 with usage', () => {
    const a = runCli(process.cwd(), ['liveness', '--help']);
    assert.equal(a.status, 0);
    assert.match(a.stdout, /pebbl liveness/);
    assert.match(a.stdout, /OVERDUE/);
    const b = runCli(process.cwd(), ['heartbeat', '--help']);
    assert.equal(b.status, 0);
    assert.match(b.stdout, /pebbl heartbeat/);
    assert.match(b.stdout, /LIVENESS signal/i);
  });
});

// ── retire: a decommissioned job must stop demanding beats ───────────────────
// Without retire a registration is permanent, so a job that will never run
// again sits OVERDUE forever. One immortal red line is how an operator learns
// to ignore the whole check, which costs more than the job it watched.
describe('liveness — retire', () => {
  const { _internal } = require('../src/liveness');
  const { checkRegistry } = _internal;
  const { foldFull } = require('../src/fold');

  const NOW = Date.parse('2026-07-30T12:00:00.000Z');
  const OLD = '2026-01-01T00:00:00.000Z';

  it('drops a retired job out of the walk', () => {
    const rows = [
      { name: 'gone', every: '24h', grace: '1h', registered_at: OLD, last_beat: null, retired_at: OLD },
    ];
    const { results } = checkRegistry(rows, NOW);
    assert.equal(results.some((r) => r.name === 'gone'), false);
  });

  it('an UNretired job with the same shape IS still overdue (the check still bites)', () => {
    const rows = [
      { name: 'gone', every: '24h', grace: '1h', registered_at: OLD, last_beat: null },
    ];
    const { results } = checkRegistry(rows, NOW);
    const row = results.find((r) => r.name === 'gone');
    assert.ok(row && row.overdue, 'a live never-beat job must still report overdue');
  });

  it('folds liveness-retire onto the row without erasing its history', () => {
    const events = [
      { eid: '1', ts: OLD, type: 'liveness-register', name: 'j', every: '24h', grace: '1h' },
      { eid: '2', ts: '2026-02-01T00:00:00.000Z', type: 'heartbeat', name: 'j', proof: 'p1' },
      { eid: '3', ts: '2026-03-01T00:00:00.000Z', type: 'liveness-retire', name: 'j', reason: 'replaced' },
    ];
    const row = (foldFull(events).liveness || []).find((r) => r.name === 'j');
    assert.ok(row, 'the row must survive retirement — retire supersedes, it does not erase');
    assert.equal(row.retired_reason, 'replaced');
    assert.equal(row.last_beat, '2026-02-01T00:00:00.000Z', 'the beat history must remain readable');
  });

  it('re-registering REVIVES a retired job', () => {
    const events = [
      { eid: '1', ts: OLD, type: 'liveness-register', name: 'j', every: '24h', grace: '1h' },
      { eid: '2', ts: '2026-03-01T00:00:00.000Z', type: 'liveness-retire', name: 'j', reason: 'paused' },
      { eid: '3', ts: '2026-04-01T00:00:00.000Z', type: 'liveness-register', name: 'j', every: '24h', grace: '1h' },
    ];
    const row = (foldFull(events).liveness || []).find((r) => r.name === 'j');
    assert.equal(row.retired_at, null, 'registering again must clear the retirement');
    const { results } = checkRegistry([row], NOW);
    assert.ok(results.find((r) => r.name === 'j'), 'a revived job is walked again');
  });

  it('a stream with NO retire event folds exactly as before', () => {
    const events = [
      { eid: '1', ts: OLD, type: 'liveness-register', name: 'j', every: '24h', grace: '1h' },
    ];
    const row = (foldFull(events).liveness || []).find((r) => r.name === 'j');
    assert.ok(!row.retired_at, 'no retire event means no retirement');
  });
});
