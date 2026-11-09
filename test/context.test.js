'use strict';

// context output cap + section order (the baton read). `pebbl context` is what a
// long-running loop reads on every wake, so its size is bounded by construction:
// capOutput keeps the first CONTEXT_CAP chars (default 6000); the open handoff
// and its linked docs come first, then the decisions (RECENT), then the rest, so
// the cut drops the index before it drops a decision. --full lifts the cap,
// --cap <n> moves it. Exercised against the REAL CLI on a seeded legacy store.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { capOutput, CONTEXT_CAP } = require('../src/context');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// A legacy (db.sqlite) store with an open handoff that links a doc, a narrative,
// and entries big enough that the default render runs well past the cap. Same
// seeding approach as context-order.test.js.
function seededProject() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-ctxcap-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.pebbl'));
  spawnSync('node', [BIN, 'log', 'seed', '--tier', 'detail', '--cat', 'quality'], { cwd: d, encoding: 'utf8' });
  for (const f of ['events.jsonl', 'events.local.jsonl', 'view.sqlite']) {
    try { fs.rmSync(path.join(d, '.pebbl', f), { force: true }); } catch {}
  }
  fs.writeFileSync(path.join(d, '.pebbl', 'narrative.md'), '# Project Narrative\nNARRATIVE-MARKER a small project.\n');
  const db = new Database(path.join(d, '.pebbl', 'db.sqlite'));
  db.exec('DELETE FROM logs');
  const ins = db.prepare(`INSERT INTO logs (timestamp, source, category, tier, message, topics, valid_from, importance, access_count)
                          VALUES (@ts, 'human', 'decision', 'component', @message, @topics, @ts, 4, 0)`);
  for (let i = 0; i < 6; i++) {
    ins.run({ ts: `2026-0${i + 1}-01T00:00:00.000Z`, topics: `area${i}`, message: `DECISION-${i} ` + 'because reasons. '.repeat(120) });
  }
  db.prepare(`INSERT INTO handoffs (timestamp, summary, done, todo, topics, status, session_entries, session_commits, docs)
              VALUES (?, ?, ?, ?, ?, 'open', '[]', '[]', ?)`)
    .run(new Date().toISOString(), 'HANDOFF-MARKER baton for the next wake', 'shipped the thing', 'next step (docs/14.02)', 'loop', JSON.stringify(['docs/14.02 Loop.md']));
  db.close();
  return d;
}

function run(dir, args) {
  return spawnSync('node', [BIN, 'context', ...args], { cwd: dir, encoding: 'utf8' });
}

describe('capOutput', () => {
  it('leaves text within the cap alone, including under a non-finite cap', () => {
    assert.equal(capOutput('short', 6000), 'short');
    const long = 'x'.repeat(10000);
    assert.equal(capOutput(long, Infinity), long);
  });

  it('cuts on a line boundary, never exceeds the cap, and says how to see the rest', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ` + 'y'.repeat(40));
    const text = lines.join('\n');
    const out = capOutput(text, 1000);
    assert.ok(out.length <= 1000, `len ${out.length}`);
    const kept = out.split('\n');
    const trailer = kept.pop();
    assert.match(trailer, /capped at 1000 chars \(\d+ in full\)/);
    assert.match(trailer, /--full/);
    for (const l of kept) assert.ok(lines.includes(l), `partial line kept: ${l}`);
  });

  it('cuts inside a long line rather than wasting most of the budget on it', () => {
    const text = 'head\n' + 'z'.repeat(5000) + '\ntail';
    const out = capOutput(text, 1000);
    assert.ok(out.length <= 1000);
    assert.ok(out.length > 900, `budget mostly used, got ${out.length}`);
    assert.match(out, /^head\nz+/);
  });

  it('the default cap is 6000', () => assert.equal(CONTEXT_CAP, 6000));
});

describe('pebbl context is capped and ordered handoff -> decisions -> the rest', () => {
  it('default output never exceeds the cap, keeps the handoff and its doc, ends with the cap note', () => {
    const dir = seededProject();
    const r = run(dir, []);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.replace(/\n$/, '');
    assert.ok(out.length <= CONTEXT_CAP, `output is ${out.length} chars`);
    assert.match(out, /HANDOFF-MARKER/);
    assert.match(out, /docs\/14\.02 Loop\.md/);
    assert.match(out.split('\n').pop(), /capped at 6000 chars/);
    assert.ok(out.indexOf('── Open handoff') < out.indexOf('--- RECENT ---'), 'handoff before decisions');
  });

  it('--full lifts the cap and shows every section in order', () => {
    const dir = seededProject();
    const r = run(dir, ['--full']);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    assert.ok(out.length > CONTEXT_CAP, `full output is only ${out.length} chars`);
    assert.doesNotMatch(out, /capped at/);
    assert.doesNotMatch(r.stderr, /unknown flag --full/);
    const at = (s) => { const i = out.indexOf(s); assert.notEqual(i, -1, `${s} missing`); return i; };
    assert.ok(at('── Open handoff') < at('--- RECENT ---'));
    assert.ok(at('--- RECENT ---') < at('--- NARRATIVE ---'));
    assert.ok(at('--- NARRATIVE ---') < at('--- TOPICS'));
    assert.match(out, /NARRATIVE-MARKER/);
  });

  it('--cap <n> moves the cap; a non-integer or non-positive value is refused', () => {
    const dir = seededProject();
    const r = run(dir, ['--cap', '1500']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.replace(/\n$/, '').length <= 1500);
    assert.match(r.stdout, /capped at 1500 chars/);
    assert.equal(run(dir, ['--cap', 'abc']).status, 1);
    assert.equal(run(dir, ['--cap', '0']).status, 1);
  });

  it('a store that fits is printed whole, with no cap note', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-ctxsmall-'));
    dirs.push(d);
    fs.mkdirSync(path.join(d, '.pebbl'));
    spawnSync('node', [BIN, 'log', 'tiny store entry', '--tier', 'detail', '--cat', 'quality'], { cwd: d, encoding: 'utf8' });
    const r = run(d, []);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /capped at/);
    assert.match(r.stdout, /tiny store entry/);
  });
});
