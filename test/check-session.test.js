'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { _internal } = require('../src/check-session');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');

function pebbl(dir, args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', input });
}

// A transcript shaped like Claude Code's: metadata lines with no timestamp first.
function transcript(dir, startIso) {
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, [
    JSON.stringify({ type: 'mode', mode: 'normal' }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'auto' }),
    JSON.stringify({ type: 'user', timestamp: startIso, message: {} }),
  ].join('\n') + '\n');
  return p;
}

function hookInput(tp, extra = {}) {
  return JSON.stringify({ hook_event_name: 'Stop', transcript_path: tp, stop_hook_active: false, ...extra });
}

describe('check-session (end to end)', () => {
  let dir, tdir, tp;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-cs-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    pebbl(dir, ['init', '--no-claude-hooks']);
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const past = new Date(Date.now() - 3600000).toISOString();
    execFileSync('git', ['commit', '-q', '-m', 'setup'], { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: past, GIT_AUTHOR_DATE: past } });
    // The session starts after setup; its transcript lives outside the repo.
    tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-cs-t-'));
    tp = transcript(tdir, new Date().toISOString());
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tdir, { recursive: true, force: true });
  });

  const block = (r) => (r.stdout.trim() ? JSON.parse(r.stdout) : null);

  it('passes a turn that changed nothing', () => {
    const r = pebbl(dir, ['check-session'], hookInput(tp));
    assert.equal(r.status, 0);
    assert.equal(block(r), null);
  });

  it('holds a turn that changed a file without logging, and asks for a handoff', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const r = pebbl(dir, ['check-session'], hookInput(tp));
    assert.equal(r.status, 0);
    const out = block(r);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /Files changed since the last pebbl entry/);
    assert.match(out.reason, /pebbl handoff/);
  });

  it('passes once something is logged after the change', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    pebbl(dir, ['log', 'chose x because y (see a.txt)', '--cat', 'decision', '--topic', 't']);
    assert.equal(block(pebbl(dir, ['check-session'], hookInput(tp))), null);
  });

  it('holds again when a later change outruns the last entry', () => {
    pebbl(dir, ['log', 'chose x because y (see a.txt)', '--cat', 'decision', '--topic', 't']);
    const later = path.join(dir, 'b.txt');
    fs.writeFileSync(later, 'x');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(later, future, future);
    assert.equal(block(pebbl(dir, ['check-session'], hookInput(tp))).decision, 'block');
  });

  it('a commit captured by the git hook does not count as logging', () => {
    fs.writeFileSync(path.join(dir, 'c.txt'), 'x');
    execFileSync('git', ['add', 'c.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'add c'], { cwd: dir });
    assert.equal(block(pebbl(dir, ['check-session'], hookInput(tp))).decision, 'block');
  });

  it('a handoff counts as the latest write and drops the handoff ask', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    pebbl(dir, ['handoff', 'did the a file', '--done', 'wrote a.txt']);
    assert.equal(block(pebbl(dir, ['check-session'], hookInput(tp))), null);
  });

  it('ignores changes inside .pebbl/', () => {
    fs.writeFileSync(path.join(dir, '.pebbl', 'scratch.md'), 'x');
    assert.equal(block(pebbl(dir, ['check-session'], hookInput(tp))), null);
  });

  it('stop_hook_active passes the turn', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    assert.equal(block(pebbl(dir, ['check-session'], hookInput(tp, { stop_hook_active: true }))), null);
  });

  it('garbage stdin and a missing transcript never fail the turn', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const r = pebbl(dir, ['check-session'], '{not json');
    assert.equal(r.status, 0);
    const r2 = pebbl(dir, ['check-session'], hookInput('/nope/transcript.jsonl'));
    assert.equal(r2.status, 0);
  });

  it('outside a pebbl project it passes silently', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-cs-bare-'));
    try {
      const r = pebbl(bare, ['check-session'], hookInput(tp));
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('flags a new numbered decision with no entry citing it', () => {
    const decisions = path.join(dir, 'docs', '10.01 Decisions.md');
    fs.mkdirSync(path.dirname(decisions), { recursive: true });
    fs.writeFileSync(decisions, '# Decisions\n\n1. First.\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
    fs.appendFileSync(path.join(dir, '.pebbl', 'config.yml'),
      'session_check:\n  decisions_file: "docs/10.01 Decisions.md"\n  decisions_base: HEAD\n');
    fs.appendFileSync(decisions, '2. Second.\n');
    pebbl(dir, ['log', 'unrelated note because reasons', '--cat', 'pattern', '--topic', 't']);
    const out = block(pebbl(dir, ['check-session'], hookInput(tp)));
    assert.match(out.reason, /no pebbl entry citing them: 2\b/);
    pebbl(dir, ['log', 'crews get monthly leases because IREN wants one contract (decision 2)', '--cat', 'decision', '--topic', 't']);
    assert.equal(block(pebbl(dir, ['check-session'], hookInput(tp))), null);
  });
});

describe('check-session internals', () => {
  it('sessionStart skips untimestamped metadata lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-cs-ts-'));
    try {
      const iso = '2026-10-27T10:00:00.000Z';
      assert.equal(_internal.sessionStart(transcript(dir, iso)), Date.parse(iso));
      assert.equal(_internal.sessionStart(null), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decisionNumbers reads the configured pattern and survives a bad one', () => {
    assert.deepEqual([..._internal.decisionNumbers('1. a\n2. b\nx 3. c\n', '^(\\d+)\\.\\s')], [1, 2]);
    assert.equal(_internal.decisionNumbers('1. a', '([').size, 0);
  });

  it('verdict: no change, no problem; change newer than write, one problem', () => {
    assert.deepEqual(_internal.verdict({ changeMs: null, writeMs: null, unlogged: [] }), []);
    assert.equal(_internal.verdict({ changeMs: 2, writeMs: 1, unlogged: [] }).length, 1);
    assert.deepEqual(_internal.verdict({ changeMs: 1, writeMs: 2, unlogged: [] }), []);
  });
});
