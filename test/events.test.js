'use strict';
// P0 tracer acceptance tests. These ARE the proof that an append-only
// events.jsonl merges cleanly under git and folds deterministically — they
// are not optional. All four design acceptance scenarios live here:
// two-contributor merge, torn-last-line repair, lock serialization, and
// fold determinism.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  fold,
  readEvents,
  appendEvent,
  makeAppendEvent,
  repairTrailingNewline,
  appendLogEvent,
  eventsPath,
} = require('../src/events');
const { withLock } = require('../src/lock');

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');

// These tests make their OWN git commits inside stores whose events.jsonl is
// force-added (tracked). The post-commit capture hook would append a
// commit-capture event right after every such commit — dirtying the tracked
// file and skewing the choreography — so capture is disabled for the whole
// file (children inherit the env). Capture itself is covered by
// test/compact-id-drift.test.js.
process.env.PEBBL_SKIP_CAPTURE = '1';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-ev-'));
}

// Run `git` in a dir, returning { status, stdout, stderr } without throwing
// so a merge's exit code can be asserted directly.
function git(cwd, args) {
  const res = require('child_process').spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function gitInit(cwd) {
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd });
  // deterministic default branch name across git versions
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd });
}

function pebbl(cwd, args) {
  return execFileSync('node', [PEBBL_BIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('P0: two-contributor git merge of events.jsonl', () => {
  it('merges two branch appends with exit 0, no conflict markers, both folded', () => {
    const repo = tmpDir();
    gitInit(repo);

    // init installs the merge=union driver, then commit a common base.
    pebbl(repo, ['init']);
    assert.match(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8'), /\.pebbl\/events\.jsonl merge=union/);

    pebbl(repo, ['log', 'base entry because we need a common ancestor', '--cat', 'decision', '--topic', 'base']);
    // events.jsonl is gitignored by default; force-add it so it's committed.
    execFileSync('git', ['add', '-f', '.pebbl/events.jsonl', '.gitattributes'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });

    // Branch A: contributor one logs an entry.
    execFileSync('git', ['checkout', '-q', '-b', 'contrib-a'], { cwd: repo });
    pebbl(repo, ['log', 'alice learned the cache must be warmed because cold start is slow', '--cat', 'pattern', '--topic', 'cache']);
    execFileSync('git', ['add', '-f', '.pebbl/events.jsonl'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'alice'], { cwd: repo });

    // Branch B from the SAME base: contributor two logs a different entry.
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
    execFileSync('git', ['checkout', '-q', '-b', 'contrib-b'], { cwd: repo });
    pebbl(repo, ['log', 'bob chose retry-with-jitter because thundering herd took down staging', '--cat', 'decision', '--topic', 'resilience']);
    execFileSync('git', ['add', '-f', '.pebbl/events.jsonl'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'bob'], { cwd: repo });

    // Merge A into B. With merge=union + the newline invariant this must be clean.
    const merge = git(repo, ['merge', '--no-edit', 'contrib-a']);
    assert.equal(merge.status, 0, `git merge exited non-zero:\n${merge.stdout}\n${merge.stderr}`);

    const merged = fs.readFileSync(path.join(repo, '.pebbl', 'events.jsonl'), 'utf8');
    assert.ok(!/^<<<<<<<|^=======|^>>>>>>>/m.test(merged), 'conflict markers present in events.jsonl');

    // Every line is independently valid JSON.
    const lines = merged.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `invalid JSON line: ${line}`);
    }

    // Fold surfaces BOTH contributors' entries plus the base.
    const rows = fold(readEvents(path.join(repo, '.pebbl')));
    const messages = rows.map((r) => r.message);
    assert.ok(messages.some((m) => m.includes('alice learned')), 'alice entry missing from fold');
    assert.ok(messages.some((m) => m.includes('bob chose')), 'bob entry missing from fold');
    assert.ok(messages.some((m) => m.includes('base entry')), 'base entry missing from fold');
    assert.equal(rows.length, 3);
  });
});

describe('P0: union-merge of a TORN committed base line (the design worst case)', () => {
  // The design names this exact failure as reproduced: a committed last line
  // WITHOUT a trailing newline, then a union merge, splices two JSON objects
  // onto one line — exit 0, no conflict markers, unparseable. The newline
  // invariant (repair-before-append) is what prevents it. The two earlier
  // tests cover a clean merge and torn-repair SEPARATELY; this pins the
  // combined case, which is the actual load-bearing claim of the tracer.

  // First, prove the failure is real WITHOUT the invariant: a raw `>>`
  // appender (no repair) leaves union to mangle the torn base. If this ever
  // stops corrupting, the test below is no longer guarding anything.
  it('raw concat appends onto a torn base DO corrupt under union (failure exists)', () => {
    const repo = tmpDir();
    gitInit(repo);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '.pebbl/events.jsonl merge=union\n');
    const pebblDir = path.join(repo, '.pebbl');
    fs.mkdirSync(pebblDir);
    const file = eventsPath(pebblDir);

    // committed base line with NO trailing newline (torn)
    const base = makeAppendEvent(pebblDir, { ts: '2026-01-01T00:00:00.000Z', message: 'base torn', category: 'data', tier: 'detail' });
    fs.writeFileSync(file, JSON.stringify(base)); // intentionally unterminated
    execFileSync('git', ['add', '-f', '.gitattributes', '.pebbl/events.jsonl'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });

    // branch a: RAW append (bypasses repairTrailingNewline)
    execFileSync('git', ['checkout', '-q', '-b', 'a'], { cwd: repo });
    const a = makeAppendEvent(pebblDir, { ts: '2026-01-02T00:00:00.000Z', message: 'alice', category: 'data', tier: 'detail' });
    fs.appendFileSync(file, JSON.stringify(a) + '\n');
    execFileSync('git', ['add', '-f', '.pebbl/events.jsonl'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'alice'], { cwd: repo });

    // branch b from the torn base: RAW append too
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
    execFileSync('git', ['checkout', '-q', '-b', 'b'], { cwd: repo });
    const b = makeAppendEvent(pebblDir, { ts: '2026-01-03T00:00:00.000Z', message: 'bob', category: 'data', tier: 'detail' });
    fs.appendFileSync(file, JSON.stringify(b) + '\n');
    execFileSync('git', ['add', '-f', '.pebbl/events.jsonl'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'bob'], { cwd: repo });

    const merge = git(repo, ['merge', '--no-edit', 'a']);
    assert.equal(merge.status, 0, 'union merge should still exit 0 (silent corruption, no markers)');
    const merged = fs.readFileSync(file, 'utf8');
    // The torn base got spliced: at least one line carries TWO JSON objects and
    // is unparseable. This is the silent corruption the invariant prevents.
    const someLineMangled = merged
      .split('\n')
      .filter((l) => l.trim())
      .some((l) => { try { JSON.parse(l); return false; } catch { return true; } });
    assert.ok(someLineMangled, 'expected union to splice the torn base into an unparseable line');
  });

  // Now the real assertion: when BOTH contributors append through pebbl's
  // path (repairTrailingNewline runs first), the SAME torn base merges clean.
  it('pebbl appendEvent repairs the torn base first, so the same union merge stays clean', () => {
    const repo = tmpDir();
    gitInit(repo);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '.pebbl/events.jsonl merge=union\n');
    const pebblDir = path.join(repo, '.pebbl');
    fs.mkdirSync(pebblDir);
    const file = eventsPath(pebblDir);

    // committed base line with NO trailing newline (torn) — identical setup.
    const base = makeAppendEvent(pebblDir, { ts: '2026-01-01T00:00:00.000Z', message: 'base torn', category: 'data', tier: 'detail' });
    fs.writeFileSync(file, JSON.stringify(base));
    execFileSync('git', ['add', '-f', '.gitattributes', '.pebbl/events.jsonl'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });

    // branch a: append via appendEvent (repairs the torn line BEFORE writing).
    execFileSync('git', ['checkout', '-q', '-b', 'a'], { cwd: repo });
    appendEvent(pebblDir, makeAppendEvent(pebblDir, { ts: '2026-01-02T00:00:00.000Z', message: 'alice', category: 'data', tier: 'detail' }));
    execFileSync('git', ['add', '-f', '.pebbl/events.jsonl'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'alice'], { cwd: repo });

    // branch b from the torn base: append via appendEvent (also repairs first).
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
    execFileSync('git', ['checkout', '-q', '-b', 'b'], { cwd: repo });
    appendEvent(pebblDir, makeAppendEvent(pebblDir, { ts: '2026-01-03T00:00:00.000Z', message: 'bob', category: 'data', tier: 'detail' }));
    execFileSync('git', ['add', '-f', '.pebbl/events.jsonl'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'bob'], { cwd: repo });

    const merge = git(repo, ['merge', '--no-edit', 'a']);
    assert.equal(merge.status, 0, `git merge exited non-zero:\n${merge.stdout}\n${merge.stderr}`);
    const merged = fs.readFileSync(file, 'utf8');
    assert.ok(!/^<<<<<<<|^=======|^>>>>>>>/m.test(merged), 'conflict markers present');
    for (const line of merged.split('\n').filter((l) => l.trim())) {
      assert.doesNotThrow(() => JSON.parse(line), `mangled line after merge: ${line}`);
    }
    const msgs = fold(readEvents(pebblDir)).map((r) => r.message).sort();
    assert.deepEqual(msgs, ['alice', 'base torn', 'bob'], 'fold must surface all three intact');
  });
});

describe('P0: torn-last-line repair', () => {
  it('appends without corruption when the last committed line lacks a trailing newline', () => {
    const dir = tmpDir();
    const pebblDir = path.join(dir, '.pebbl');
    fs.mkdirSync(pebblDir, { recursive: true });
    const file = eventsPath(pebblDir);

    // Write two complete lines, then a THIRD line with NO trailing newline
    // (a torn final line — exactly what an interrupted write or a union
    // merge can leave behind).
    const e1 = makeAppendEvent(pebblDir, { ts: '2026-01-01T00:00:00.000Z', message: 'first', category: 'data', tier: 'detail' });
    const e2 = makeAppendEvent(pebblDir, { ts: '2026-01-02T00:00:00.000Z', message: 'second', category: 'data', tier: 'detail' });
    const e3 = makeAppendEvent(pebblDir, { ts: '2026-01-03T00:00:00.000Z', message: 'torn third', category: 'data', tier: 'detail' });
    fs.writeFileSync(file, JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n' + JSON.stringify(e3));
    // last byte is NOT a newline
    assert.notEqual(fs.readFileSync(file)[fs.statSync(file).size - 1], 0x0a);

    // A subsequent append must repair the newline FIRST so the new line is
    // not spliced onto the torn line.
    const e4 = makeAppendEvent(pebblDir, { ts: '2026-01-04T00:00:00.000Z', message: 'fourth', category: 'data', tier: 'detail' });
    appendEvent(pebblDir, e4);

    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 4, 'expected exactly 4 lines, no mangled multi-JSON line');
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `mangled line: ${line}`);
    }
    // The previously-torn entry survived intact alongside the new one.
    const rows = fold(readEvents(pebblDir));
    const msgs = rows.map((r) => r.message);
    assert.ok(msgs.includes('torn third'));
    assert.ok(msgs.includes('fourth'));
  });

  it('repairTrailingNewline is a no-op on a well-terminated file', () => {
    const dir = tmpDir();
    const pebblDir = path.join(dir, '.pebbl');
    fs.mkdirSync(pebblDir, { recursive: true });
    const file = eventsPath(pebblDir);
    fs.writeFileSync(file, '{"a":1}\n');
    const before = fs.readFileSync(file);
    repairTrailingNewline(file);
    assert.deepEqual(fs.readFileSync(file), before);
  });
});

describe('P0: per-store lock serializes append+rebuild', () => {
  it('a held lock blocks a concurrent acquire, so no interleave', () => {
    const dir = tmpDir();
    const pebblDir = path.join(dir, '.pebbl');
    fs.mkdirSync(pebblDir, { recursive: true });

    let inner = 0;
    withLock(pebblDir, () => {
      // While we hold the lock, a second short-timeout acquire must fail
      // rather than enter the critical section in parallel.
      assert.throws(
        () => withLock(pebblDir, () => { inner++; }, { timeoutMs: 100 }),
        /could not acquire store lock/,
      );
    });
    assert.equal(inner, 0, 'concurrent critical section ran — lock did not serialize');

    // Lock is released after the block, so a fresh acquire now succeeds.
    let ran = false;
    withLock(pebblDir, () => { ran = true; });
    assert.ok(ran);
  });

  it('a concurrent cross-process append cannot interleave with appendLogEvent (both writes intact)', () => {
    // Cross-process proof: two node processes each appendLogEvent against
    // the SAME store at the same time. The per-store O_EXCL lock forces one
    // to wait for the other, so the final file has both writes, every line
    // valid JSON, and no lost or torn write. spawnSync runs them; we launch
    // the background child first, then race the parent's own append.
    const dir = tmpDir();
    const pebblDir = path.join(dir, '.pebbl');
    fs.mkdirSync(pebblDir, { recursive: true });
    gitInit(dir);

    const eventsModPath = path.join(__dirname, '..', 'src', 'events.js');
    const doneFlag = path.join(dir, 'child-done');
    const childScript = `
      const fs = require('fs');
      const { appendLogEvent } = require(${JSON.stringify(eventsModPath)});
      appendLogEvent(${JSON.stringify(pebblDir)}, { ts: '2026-02-01T00:00:00.000Z', message: 'child write', category: 'data', tier: 'detail' });
      fs.writeFileSync(${JSON.stringify(doneFlag)}, 'ok');
    `;
    // Launch the child non-blocking so it contends with the parent's
    // synchronous append below. The child writes a done-flag when finished;
    // we poll the flag (not the pid) so a blocked event loop / unreaped
    // zombie can't fool the wait.
    require('child_process').spawn('node', ['-e', childScript], { stdio: 'ignore', detached: true }).unref();

    appendLogEvent(pebblDir, { ts: '2026-01-01T00:00:00.000Z', message: 'parent write', category: 'data', tier: 'detail' });

    const deadline = Date.now() + 8000;
    while (!fs.existsSync(doneFlag) && Date.now() < deadline) {
      const until = Date.now() + 25; while (Date.now() < until) {}
    }
    assert.ok(fs.existsSync(doneFlag), 'child append process did not finish in time');

    const rows = fold(readEvents(pebblDir));
    const msgs = rows.map((r) => r.message);
    assert.ok(msgs.includes('parent write'), 'parent write lost');
    assert.ok(msgs.includes('child write'), 'child write lost');
    assert.equal(rows.length, 2, 'expected exactly both writes, no extras or losses');
    // every line valid JSON — no torn interleave
    const raw = fs.readFileSync(eventsPath(pebblDir), 'utf8');
    for (const line of raw.split('\n').filter((l) => l.trim())) {
      assert.doesNotThrow(() => JSON.parse(line), `torn line from interleave: ${line}`);
    }
  });
});

describe('P0: fold determinism', () => {
  function shuffle(arr, seed) {
    // deterministic shuffle so the test itself is reproducible
    const a = arr.slice();
    let s = seed;
    for (let i = a.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  it('folding the same events in any line order yields identical rows', () => {
    const dir = tmpDir();
    const pebblDir = path.join(dir, '.pebbl');
    fs.mkdirSync(pebblDir, { recursive: true });

    const events = [];
    for (let i = 0; i < 20; i++) {
      events.push(makeAppendEvent(pebblDir, {
        ts: new Date(Date.UTC(2026, 0, 1 + (i % 7), i % 24)).toISOString(),
        message: `entry ${i}`,
        category: 'data',
        tier: 'detail',
        topics: `t${i % 3}`,
      }));
    }

    const baseline = JSON.stringify(fold(events));
    for (const seed of [1, 7, 42, 9999]) {
      const reordered = shuffle(events, seed);
      assert.equal(JSON.stringify(fold(reordered)), baseline, `fold not deterministic for seed ${seed}`);
    }
  });

  it('ties on ts break by emitted_at then eid, total order', () => {
    const pebblDir = path.join(tmpDir(), '.pebbl');
    const sameTs = '2026-03-01T00:00:00.000Z';
    const a = { type: 'append', eid: 'B', ts: sameTs, emitted_at: sameTs, message: 'b', category: 'data', tier: 'detail', topics: [] };
    const b = { type: 'append', eid: 'A', ts: sameTs, emitted_at: sameTs, message: 'a', category: 'data', tier: 'detail', topics: [] };
    const rows = fold([a, b]);
    // eid 'A' sorts before 'B' on the final tie-break
    assert.equal(rows[0].eid, 'A');
    assert.equal(rows[1].eid, 'B');
  });
});

describe('P0: init idempotency for .gitattributes', () => {
  it('running init twice does not duplicate the merge=union line', () => {
    const dir = tmpDir();
    gitInit(dir);
    pebbl(dir, ['init']);
    pebbl(dir, ['init']);
    const ga = fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8');
    const count = ga.split('\n').filter((l) => l.trim() === '.pebbl/events.jsonl merge=union').length;
    assert.equal(count, 1, 'merge=union line duplicated on re-init');
  });
});

describe('P0: ULID', () => {
  it('mints 26-char time-sortable ids', () => {
    const { ulid } = require('../src/ulid');
    const early = ulid(1000);
    const late = ulid(2000000);
    assert.equal(early.length, 26);
    assert.equal(late.length, 26);
    assert.ok(early < late, 'ulid not time-sortable');
  });
});
