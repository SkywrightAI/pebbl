'use strict';
// `pebbl liveness register/check` + `pebbl heartbeat` — detect the ABSENCE of an
// expected event (the dog that didn't bark): a scheduled job that silently does
// not run (5am cron skipped, canary never loaded, scribe died quiet, watermark
// advanced before the work). You cannot detect an absence by watching for it, so
// flip the question to "when did this last succeed?" and alarm when that is too
// long ago. Primitive 2 of 3 (readback -> liveness -> encode); full rationale:
// notes/design-selflearning-primitives-2026-06-23.md §0/§2/§4.
//
// DETERMINISTIC, NO-LLM. A cadence contract: `register` declares an expected
// cadence (every + grace), `heartbeat` beats on VERIFIED SUCCESS (beat LAST,
// after the artifact is written), and `check` folds the registry and flags what
// is OVERDUE (now - last_beat > every + grace; a registered job that never beat
// is OVERDUE from registration).
//
// HEARTBEAT IS A LIVENESS SIGNAL, NOT A CORRECTNESS SIGNAL: a beat asserts only
// that the run reached the (end) beat — it does NOT prove the work was right.
// Correctness stays the job of a separate artifact/freshness check (brief-
// freshness, canary). `--proof` carries an optional evidence token (row count /
// output hash / artifact path) so a "beat but produced nothing" run is still
// inspectable after the fact.
//
// SELF-PROVING CHECKER (the headline — a monitor must not pass while BLIND, the
// airport-scanner test-weapon applied to the monitor): `check` (a) appends its
// OWN `heartbeat` for the `liveness-check` job and asserts its own freshness
// FIRST; (b) walks a registry that ALWAYS includes a planted, always-overdue
// SENTINEL — every healthy check MUST report that sentinel as OVERDUE. A check
// that reports ZERO overdue is itself broken (it walked nothing, or its
// comparator is dead) -> it exits NON-ZERO and prints LOUD, never silent-green.
// `check` prints the registry count it walked + the sentinel's status.

const fs = require('fs');
const { requirePebblDir } = require('./find-pebbl');
const { withLock } = require('./lock');
const {
  readEvents,
  appendEvent,
  makeLivenessRegisterEvent,
  makeLivenessRetireEvent,
  makeHeartbeatEvent,
} = require('./events');
const { foldFull } = require('./fold');
const { renderFactoryGuide } = require('./factory-guide'); // ONE printer, shared by the trio

// The job name `check` beats for itself (self-proving step a). A check first
// records that IT ran, then asserts that beat is fresh — so a check process that
// silently dies mid-run leaves a stale `liveness-check` heartbeat that a LATER
// check (or a human reading the registry) can see.
const SELF_CHECK_NAME = 'liveness-check';
// The cadence `check` self-registers for its OWN job the first time it runs, so
// the self-beat folds as a FIRST-CLASS registered job (FRESH right after it
// beats) rather than as a permanently-uncadenced OVERDUE row. The host floor is
// the Mac morning brief (~daily), so a day + a generous grace is the right
// expectation: if the brief stops running, this job goes overdue like any other.
const SELF_CHECK_EVERY = '24h';
const SELF_CHECK_GRACE = '12h';

// The planted always-overdue SENTINEL (self-proving step b). It is a CONSTANT
// registry row the checker injects into every walk — it does not depend on the
// store, so even an empty store has it. It is overdue under BOTH overdue paths
// at once (defense in depth): registered in the distant past with NO heartbeat
// (overdue-from-registration), AND carrying an ancient last_beat with a tiny
// `every` (overdue-by-interval). A healthy `now - last_beat > every + grace`
// comparator can ONLY report it OVERDUE; if it ever reports the sentinel fresh,
// the comparator is broken and we go loud.
const SENTINEL_NAME = '__liveness_sentinel__';
const SENTINEL_REGISTERED_AT = '1970-01-01T00:00:00.000Z';
const SENTINEL_LAST_BEAT = '1970-01-01T00:00:00.000Z';
const SENTINEL_ROW = Object.freeze({
  name: SENTINEL_NAME,
  every: '1s',
  grace: '0s',
  registered_at: SENTINEL_REGISTERED_AT,
  last_beat: SENTINEL_LAST_BEAT,
  last_proof: 'planted always-overdue sentinel — a healthy check MUST flag this',
  sentinel: true,
});

// How fresh `check`'s own self-beat must be to count as "this check ran just
// now" (self-proving step a). Generous — it only has to bound a wedged process,
// not a tight SLA; the beat was written microseconds earlier in the same call.
const SELF_FRESH_MS = 5 * 60 * 1000; // 5 minutes

// ── duration parsing ─────────────────────────────────────────────────────────
//
// A cadence is a human duration string: `24h`, `90m`, `2d`, `45s`, `1w`. We keep
// the wire form a STRING (events.js stores `every`/`grace` verbatim) and parse
// here, so the registry stays human-readable and the math lives in one place
// (DRY). Accepts an optional leading sign-free integer/decimal + a unit suffix;
// a bare number is treated as seconds. Unknown/empty -> null (the caller decides
// what a missing cadence means).
const UNIT_MS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

function parseDuration(str) {
  if (str == null) return null;
  const s = String(str).trim().toLowerCase();
  if (s === '') return null;
  // number + optional unit (ms|s|m|h|d|w). A bare number == seconds.
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] || 's';
  return Math.round(n * UNIT_MS[unit]);
}

// ── pure evaluation (testable without a store) ───────────────────────────────
//
// evaluateRegistry(rows, nowMs) -> the per-job liveness status array. PURE: no
// I/O, no Date.now (now is injected), deterministic given (rows, nowMs). This is
// the piece a unit test drives directly to prove OVERDUE / FRESH / NEVER-BEAT,
// and to prove the must-trip guard (an empty/blind registry computes zero
// overdue, which checkRegistry below turns into a non-zero exit).
//
// OVERDUE rule (design §2): overdue when `now - last_beat > every + grace`. A
// registered job that NEVER beat (last_beat == null) is overdue from its
// registered_at — measured the same way, with registered_at standing in for the
// missing beat. A job with neither a parseable `every` nor a last_beat/registered
// floor cannot be judged -> it is reported overdue (unknown cadence is a wiring
// hole, not a pass) with reason 'unregistered-or-uncadenced'.
function evaluateRegistry(rows, nowMs) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((r) => {
    const everyMs = parseDuration(r.every);
    const graceMs = parseDuration(r.grace) || 0;
    const deadlineBudget = (everyMs == null ? null : everyMs + graceMs);

    // The clock we measure from: the last verified beat, else (never beat) the
    // registration floor. If we have neither, the job is uncadenced.
    const sinceTs = r.last_beat || r.registered_at || null;
    const sinceMs = sinceTs ? Date.parse(sinceTs) : NaN;

    let overdue;
    let reason;
    let age_ms = null;

    if (deadlineBudget == null || !Number.isFinite(sinceMs)) {
      // No parseable cadence OR no floor to measure from: cannot prove liveness,
      // so it does not get to pass. A registered-but-never-beat job DOES have a
      // floor (registered_at), so it lands in the normal path below, not here.
      overdue = true;
      reason = (deadlineBudget == null)
        ? 'no-parseable-cadence'
        : 'no-beat-or-registration-floor';
    } else {
      age_ms = nowMs - sinceMs;
      overdue = age_ms > deadlineBudget;
      if (!r.last_beat) {
        reason = overdue ? 'never-beat-past-deadline' : 'never-beat-within-grace';
      } else {
        reason = overdue ? 'beat-too-old' : 'fresh';
      }
    }

    return {
      name: r.name,
      every: r.every || '',
      grace: r.grace || '',
      registered_at: r.registered_at || null,
      last_beat: r.last_beat || null,
      last_proof: r.last_proof || '',
      sentinel: !!r.sentinel,
      age_ms,
      deadline_ms: deadlineBudget,
      overdue,
      reason,
    };
  });
}

// ── the self-proving walk ────────────────────────────────────────────────────
//
// checkRegistry(registryRows, nowMs) -> { results, overdue, sentinel, healthy,
// reason }. PURE. registryRows is the store's folded `liveness` projection; this
// function ALWAYS appends the planted SENTINEL_ROW before evaluating, so the
// walked set is never empty. `healthy` is the self-proof:
//   - the sentinel MUST evaluate overdue (the comparator is alive), AND
//   - there must be >=1 overdue overall (a check reporting zero overdue is blind
//     — it walked nothing real or its comparator is dead).
// A NON-healthy result is what the CLI turns into a LOUD non-zero exit. This is
// the B4/F2 fix: the monitor cannot pass while blind. A deliberately-empty or
// comparator-broken registry computes healthy=false here, which the test asserts.
function checkRegistry(registryRows, nowMs) {
  const base = Array.isArray(registryRows) ? registryRows.slice() : [];
  // RETIRED contracts drop out of the walk. A decommissioned job can never beat
  // again, so leaving it in would produce a permanently OVERDUE row — and a red
  // line that is always red teaches the operator to stop reading the check,
  // which costs more than the job it was watching. The row stays in the fold
  // (retire supersedes, it does not erase), so `--json` consumers can still see
  // that it existed and why it stopped.
  //
  // The sentinel is always part of the walk. We strip any same-named row first
  // so a store can never shadow/override the planted sentinel with a fresh one.
  const live = base.filter((r) => r && !r.retired_at);
  const walked = live.filter((r) => r && r.name !== SENTINEL_NAME);
  walked.push({ ...SENTINEL_ROW });

  const results = evaluateRegistry(walked, nowMs);
  const overdue = results.filter((r) => r.overdue);
  const sentinel = results.find((r) => r.sentinel) || null;

  const sentinelOverdue = !!(sentinel && sentinel.overdue);
  // Healthy ONLY when the comparator proved itself on the sentinel AND at least
  // one job is overdue (the sentinel guarantees >=1 in a working check, so
  // zero-overdue == blind). Both must hold.
  const healthy = sentinelOverdue && overdue.length >= 1;

  let reason = 'ok';
  if (!sentinelOverdue) {
    reason = 'BLIND: the planted always-overdue sentinel was NOT reported overdue — the liveness comparator is broken';
  } else if (overdue.length < 1) {
    reason = 'BLIND: zero overdue reported (a working check always trips the sentinel) — the checker walked nothing';
  }

  return {
    results,
    overdue,
    sentinel,
    walked_count: results.length,
    healthy,
    reason,
  };
}

// ── store side-effects (register / heartbeat / the self-beat) ────────────────
//
// Each append rides the SAME path the rest of pebbl uses: withLock (serialize
// against concurrent writers) + appendEvent (trailing-newline / torn-line
// invariant). We do NOT rebuild the markdown view here — liveness lives in its
// own projection, read by `check` via foldFull; the log/handoff projections are
// unaffected (and rebuilding them on a heartbeat would be churn). Returns the
// appended event.
function appendRegister(pebblDir, { name, every, grace }) {
  return withLock(pebblDir, () => {
    const event = makeLivenessRegisterEvent(pebblDir, { name, every, grace });
    appendEvent(pebblDir, event);
    return event;
  });
}

function appendRetire(pebblDir, { name, reason }) {
  return withLock(pebblDir, () => {
    const event = makeLivenessRetireEvent(pebblDir, { name, reason });
    appendEvent(pebblDir, event);
    return event;
  });
}

function appendHeartbeat(pebblDir, { name, proof }) {
  return withLock(pebblDir, () => {
    const event = makeHeartbeatEvent(pebblDir, { name, proof });
    appendEvent(pebblDir, event);
    return event;
  });
}

// Fold the store to its liveness registry projection (the array of cadence rows).
function loadRegistry(pebblDir) {
  return foldFull(readEvents(pebblDir)).liveness || [];
}

// ── --factory-guide (static trigger-condition manifests, B3 fix) ─────────────
//
// Per-command STATIC manifest of TRIGGER-CONDITIONS (call_when/precondition/
// effect/consumes/produces), NOT host stage names — a host factory binds its own
// stages. EVERY edge carries status: BUILT|PLANNED; the integrating agent treats
// PLANNED as "surface it, do not wire." pebbl only emits edges it can name from
// its own siblings (heartbeat/register/check = BUILT) plus the declared
// downstreams that are NOT yet built (scheduler-derived-registry = PLANNED). No
// store access.
const FACTORY_GUIDE = {
  heartbeat: {
    command: 'heartbeat',
    call_when: 'any scheduled job, on VERIFIED success — beat LAST, after the artifact is written and checked',
    precondition: 'the job ran and its real output exists (a beat is a liveness signal, not a correctness signal)',
    effect: 'records this job is alive at now; absence of a beat is what `liveness check` later alarms on',
    consumes: 'a job name (+ optional --proof evidence token)',
    produces: 'a heartbeat event in the store (folds into the liveness registry projection)',
    edges: [
      { to: 'pebbl liveness register', status: 'BUILT' },     // declares the cadence this beat satisfies
      { to: 'pebbl liveness check', status: 'BUILT' },        // the consumer that alarms on a missing beat
      { to: 'artifact/freshness check (correctness)', status: 'PLANNED' }, // the separate correctness half (F3)
    ],
  },
  liveness: {
    command: 'liveness',
    call_when: 'register: once per scheduled job (declare its cadence). check: on the ONE human floor — the Mac morning brief',
    precondition: 'every scheduled job that should beat has a liveness-register; the brief runs check on a real schedule',
    effect: 'check flags OVERDUE jobs LOUD; a planted sentinel must always trip, so a blind/empty check exits non-zero (never silent-green)',
    consumes: 'the folded liveness registry (register + heartbeat events)',
    produces: 'an OVERDUE report (name, last_beat, age, reason) + the sentinel status + the registry count walked',
    edges: [
      { to: 'pebbl heartbeat', status: 'BUILT' },             // the signal check consumes
      { to: 'scheduler-derived registry (crontab/LaunchAgent plists)', status: 'PLANNED' }, // derive the known-critical set from the real scheduler (F1)
      { to: 'morning-brief surface', status: 'PLANNED' },     // the host channel that runs check + shows OVERDUE
    ],
  },
};

function printFactoryGuide(which, asJson) {
  process.stdout.write(renderFactoryGuide(FACTORY_GUIDE[which], { json: asJson }));
}

// ── CLI arg parsing (own raw-argv parse, like readback/context) ──────────────
function parseFlags(args) {
  const out = { json: false, factoryGuide: false, proof: null, every: null, grace: null, reason: null, positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--factory-guide') { out.factoryGuide = true; continue; }
    if (a === '--proof') { const v = args[i + 1]; if (v !== undefined && !v.startsWith('--')) { out.proof = v; i++; } continue; }
    if (a.startsWith('--proof=')) { out.proof = a.slice('--proof='.length); continue; }
    if (a === '--every') { const v = args[i + 1]; if (v !== undefined && !v.startsWith('--')) { out.every = v; i++; } continue; }
    if (a.startsWith('--every=')) { out.every = a.slice('--every='.length); continue; }
    if (a === '--grace') { const v = args[i + 1]; if (v !== undefined && !v.startsWith('--')) { out.grace = v; i++; } continue; }
    if (a.startsWith('--grace=')) { out.grace = a.slice('--grace='.length); continue; }
    if (a === '--reason') { const v = args[i + 1]; if (v !== undefined && !v.startsWith('--')) { out.reason = v; i++; } continue; }
    if (a.startsWith('--reason=')) { out.reason = a.slice('--reason='.length); continue; }
    if (a.startsWith('--')) continue;              // ignore unknown flags
    out.positionals.push(a);
  }
  return out;
}

// ── human / JSON rendering of a check ────────────────────────────────────────
function renderCheck(report, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify({
      healthy: report.healthy,
      reason: report.reason,
      walked_count: report.walked_count,
      sentinel: report.sentinel
        ? { name: report.sentinel.name, overdue: report.sentinel.overdue, reason: report.sentinel.reason }
        : null,
      overdue: report.overdue.map((r) => ({
        name: r.name, last_beat: r.last_beat, registered_at: r.registered_at,
        every: r.every, grace: r.grace, age_ms: r.age_ms, reason: r.reason, sentinel: r.sentinel,
      })),
      results: report.results,
    }, null, 2) + '\n');
    return;
  }
  const out = [];
  out.push('\n--- LIVENESS CHECK ---');
  out.push(`registry walked: ${report.walked_count} job(s) (incl. the planted sentinel)`);
  const sStatus = report.sentinel
    ? (report.sentinel.overdue ? 'OVERDUE (as it must be)' : 'NOT OVERDUE — BROKEN')
    : 'MISSING — BROKEN';
  out.push(`sentinel (${SENTINEL_NAME}): ${sStatus}`);
  if (!report.healthy) {
    out.push('');
    out.push(`!! CHECK IS NOT HEALTHY: ${report.reason}`);
    out.push('!! Treat this as a HARD FAILURE — the monitor is blind, not green.');
  }
  const realOverdue = report.overdue.filter((r) => !r.sentinel);
  out.push('');
  if (realOverdue.length === 0) {
    out.push('No real jobs OVERDUE (only the sentinel, as expected).');
  } else {
    out.push(`OVERDUE jobs (${realOverdue.length}):`);
    for (const r of realOverdue) {
      const age = r.age_ms == null ? 'n/a' : `${Math.round(r.age_ms / 1000)}s since floor`;
      out.push(`  [OVERDUE] ${r.name}  (every ${r.every || '?'}, grace ${r.grace || '0'}, ${age}, ${r.reason})`);
      if (r.last_beat) out.push(`            last beat: ${r.last_beat}`);
      else out.push(`            never beat (registered ${r.registered_at || '?'})`);
    }
  }
  out.push('---\n');
  process.stdout.write(out.join('\n') + '\n');
}

// ── subcommand handlers ──────────────────────────────────────────────────────

// `pebbl heartbeat <name> [--proof <token>]`
function heartbeatCmd(args) {
  const opts = parseFlags(args);
  if (opts.factoryGuide) { printFactoryGuide('heartbeat', opts.json); return; }
  const name = opts.positionals[0];
  if (!name) {
    console.error('Usage: pebbl heartbeat <name> [--proof <token>]');
    console.error('       pebbl heartbeat --factory-guide [--json]');
    process.exit(1);
  }
  const pebblDir = requirePebblDir();
  const event = appendHeartbeat(pebblDir, { name, proof: opts.proof });
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, name, ts: event.ts, proof: event.proof, eid: event.eid }) + '\n');
  } else {
    process.stdout.write(`heartbeat: ${name} beat at ${event.ts}${event.proof ? ` (proof: ${event.proof})` : ''}\n`);
  }
}

// `pebbl liveness register <name> --every <dur> [--grace <dur>]`
function registerCmd(args) {
  const opts = parseFlags(args);
  const name = opts.positionals[0];
  if (!name || !opts.every) {
    console.error('Usage: pebbl liveness register <name> --every <dur> [--grace <dur>]');
    process.exit(1);
  }
  if (parseDuration(opts.every) == null) {
    console.error(`pebbl liveness register: --every '${opts.every}' is not a duration (e.g. 24h, 90m, 2d, 45s)`);
    process.exit(1);
  }
  if (opts.grace != null && parseDuration(opts.grace) == null) {
    console.error(`pebbl liveness register: --grace '${opts.grace}' is not a duration (e.g. 1h, 30m)`);
    process.exit(1);
  }
  const pebblDir = requirePebblDir();
  const event = appendRegister(pebblDir, { name, every: opts.every, grace: opts.grace });
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, name, every: event.every, grace: event.grace, eid: event.eid }) + '\n');
  } else {
    process.stdout.write(`registered: ${name} every ${event.every}${event.grace ? ` (grace ${event.grace})` : ''}\n`);
  }
}

// `pebbl liveness retire <name> --reason "..."`
//
// Stop watching a decommissioned job. A `--reason` is required for the same
// reason an audit accept requires one: this silences an alarm, and a silencing
// nobody wrote down is indistinguishable from an alarm that was ignored. The
// row stays in the fold, so `check --json` can still show it was retired and
// why; re-registering the name revives it.
function retireCmd(args) {
  const opts = parseFlags(args);
  const name = opts.positionals[0];
  if (!name) {
    console.error('Usage: pebbl liveness retire <name> --reason "why it no longer runs"');
    process.exit(1);
  }
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (!reason) {
    console.error('pebbl liveness retire: --reason "why it no longer runs" is required.');
    console.error('Retiring silences a check forever; an unexplained silence reads the same');
    console.error('as an alarm everyone learned to ignore. Say what replaced it, or that');
    console.error('the job is gone.');
    process.exit(1);
  }
  const pebblDir = requirePebblDir();
  const registry = loadRegistry(pebblDir);
  if (!registry.some((r) => r && r.name === name)) {
    // Not fatal — retiring something that was never registered is a harmless
    // no-op decision — but say so, because the usual cause is a typo, and a
    // silent success would leave the REAL job still alarming.
    console.error(`pebbl liveness retire: warning — no registered job named '${name}'.`);
    console.error(`Registered: ${registry.map((r) => r.name).join(', ') || '(none)'}`);
  }
  const event = appendRetire(pebblDir, { name, reason });
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, name, reason, eid: event.eid }) + '\n');
  } else {
    process.stdout.write(`retired: ${name} — ${reason}\n`);
  }
}

// `pebbl liveness check [--json]` — the self-proving walk.
//
// Order matters: (1) beat our OWN liveness-check heartbeat and assert it is
// fresh (self-proof a — a check that can't even record itself is broken), then
// (2) fold the registry and run the sentinel-guarded walk (self-proof b). A
// non-healthy walk OR a stale self-beat exits NON-ZERO and prints LOUD.
function checkCmd(args) {
  const opts = parseFlags(args);
  if (opts.factoryGuide) { printFactoryGuide('liveness', opts.json); return; }

  const pebblDir = requirePebblDir();
  const nowMs = Date.now();

  // (a) Self-beat: record that THIS check ran, then re-read and assert freshness.
  let selfFresh = true;
  let selfReason = 'ok';
  try {
    // Self-register the check's own cadence ONCE (idempotent: only if the folded
    // registry has no cadence for it yet), so the self-beat folds as a proper
    // FRESH job instead of a permanently-uncadenced OVERDUE row.
    const before = loadRegistry(pebblDir);
    const selfBefore = before.find((r) => r.name === SELF_CHECK_NAME);
    if (!selfBefore || !selfBefore.every) {
      appendRegister(pebblDir, { name: SELF_CHECK_NAME, every: SELF_CHECK_EVERY, grace: SELF_CHECK_GRACE });
    }
    appendHeartbeat(pebblDir, { name: SELF_CHECK_NAME, proof: `check@${new Date(nowMs).toISOString()}` });
    const reg = loadRegistry(pebblDir);
    const selfRow = reg.find((r) => r.name === SELF_CHECK_NAME);
    const beatMs = selfRow && selfRow.last_beat ? Date.parse(selfRow.last_beat) : NaN;
    if (!Number.isFinite(beatMs) || (Date.now() - beatMs) > SELF_FRESH_MS) {
      selfFresh = false;
      selfReason = 'self-heartbeat did not land fresh — the check could not prove it ran';
    }
  } catch (err) {
    selfFresh = false;
    selfReason = `self-heartbeat append failed: ${err.message}`;
  }

  // (b) Sentinel-guarded walk over the folded registry.
  const registry = loadRegistry(pebblDir);
  const report = checkRegistry(registry, nowMs);

  renderCheck(report, opts.json);

  if (!selfFresh) {
    process.stderr.write(`\n!! LIVENESS CHECK SELF-PROOF FAILED: ${selfReason}\n`);
  }
  if (!report.healthy || !selfFresh) {
    // LOUD, non-zero. A blind or self-unproven check must never read as green.
    process.exit(1);
  }
}

// `pebbl liveness <subcommand>` dispatch.
function livenessCmd(args) {
  const sub = args[0];
  const rest = args.slice(1);
  // `pebbl liveness --factory-guide` (no subcommand) describes the liveness command.
  if (sub === '--factory-guide') { const o = parseFlags(args); printFactoryGuide('liveness', o.json); return; }
  if (sub === 'register') { registerCmd(rest); return; }
  if (sub === 'retire') { retireCmd(rest); return; }
  if (sub === 'check') { checkCmd(rest); return; }
  console.error('Usage: pebbl liveness register <name> --every <dur> [--grace <dur>]');
  console.error('       pebbl liveness check [--json]');
  console.error('       pebbl liveness retire <name> --reason "why it no longer runs"');
  console.error('       pebbl liveness --factory-guide [--json]');
  process.exit(1);
}

module.exports = { liveness: livenessCmd, heartbeat: heartbeatCmd };

// Internal surface for tests (pure pieces + constants), mirroring readback._internal.
module.exports._internal = {
  parseDuration, evaluateRegistry, checkRegistry,
  appendRegister, appendRetire, appendHeartbeat, loadRegistry,
  FACTORY_GUIDE, SENTINEL_NAME, SENTINEL_ROW,
  SELF_CHECK_NAME, SELF_CHECK_EVERY, SELF_CHECK_GRACE, SELF_FRESH_MS,
};
