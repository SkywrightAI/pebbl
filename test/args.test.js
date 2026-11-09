'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../src/args');

describe('parseArgs', () => {
  it('parses flags with values', () => {
    const result = parseArgs(['chose', 'SQLite', '--cat', 'decision', '--topic', 'datastore']);
    assert.deepStrictEqual(result.flags, { cat: 'decision', topic: 'datastore' });
    assert.deepStrictEqual(result.positional, ['chose', 'SQLite']);
  });

  it('parses boolean flags (--preview, --execute)', () => {
    const result = parseArgs(['--preview']);
    assert.deepStrictEqual(result.flags, { preview: true });
    assert.deepStrictEqual(result.positional, []);
  });

  it('parses --execute as boolean', () => {
    const result = parseArgs(['--execute', '--resolve', '22:signal', 'extra']);
    assert.deepStrictEqual(result.flags, { execute: true, resolve: '22:signal' });
    assert.deepStrictEqual(result.positional, ['extra']);
  });

  it('handles mixed positional and flags', () => {
    const result = parseArgs(['hello', '--cat', 'pattern', 'world', '--tier', 'signal']);
    assert.deepStrictEqual(result.flags, { cat: 'pattern', tier: 'signal' });
    assert.deepStrictEqual(result.positional, ['hello', 'world']);
  });

  it('passes unknown flags through as positional and warns on stderr', () => {
    const written = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { written.push(chunk); return true; };
    try {
      const result = parseArgs(['--unknown', 'value', '--cat', 'decision']);
      assert.deepStrictEqual(result.flags, { cat: 'decision' });
      assert.deepStrictEqual(result.positional, ['--unknown', 'value']);
      assert.ok(written.some(l => l.includes('unknown flag --unknown')), 'expected warning for --unknown');
    } finally {
      process.stderr.write = orig;
    }
  });

  it('emits no warning for known flags', () => {
    const written = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { written.push(chunk); return true; };
    try {
      parseArgs(['--cat', 'decision', '--preview']);
      assert.strictEqual(written.length, 0, 'expected no warnings for known flags');
    } finally {
      process.stderr.write = orig;
    }
  });

  it('returns empty for no args', () => {
    const result = parseArgs([]);
    assert.deepStrictEqual(result.flags, {});
    assert.deepStrictEqual(result.positional, []);
  });

  it('handles all positional with no flags', () => {
    const result = parseArgs(['just', 'a', 'message']);
    assert.deepStrictEqual(result.flags, {});
    assert.deepStrictEqual(result.positional, ['just', 'a', 'message']);
  });

  it('handles flag with no following value', () => {
    const result = parseArgs(['--cat', '--topic', 'auth']);
    assert.deepStrictEqual(result.flags, { topic: 'auth' });
    assert.deepStrictEqual(result.positional, []);
  });

  it('handles boolean flag inline with other params', () => {
    const result = parseArgs(['--preview', '--cat', 'decision']);
    assert.deepStrictEqual(result.flags, { preview: true, cat: 'decision' });
    assert.deepStrictEqual(result.positional, []);
  });

  it('parses relates and corrects as value flags', () => {
    const result = parseArgs(['fixed', '--relates', '5', '--corrects', '3']);
    assert.deepStrictEqual(result.flags, { relates: '5', corrects: '3' });
    assert.deepStrictEqual(result.positional, ['fixed']);
  });

  it('parses source and tier flags', () => {
    const result = parseArgs(['note', '--source', 'agent', '--tier', 'fleeting']);
    assert.deepStrictEqual(result.flags, { source: 'agent', tier: 'fleeting' });
    assert.deepStrictEqual(result.positional, ['note']);
  });

  it('parses resolve flag with value', () => {
    const result = parseArgs(['--resolve', '22:signal,15:rollup']);
    assert.deepStrictEqual(result.flags, { resolve: '22:signal,15:rollup' });
    assert.deepStrictEqual(result.positional, []);
  });

  it('parses handoff value flags (--done, --todo, --blocked) as arrays', () => {
    // MULTI_FLAGS always land as arrays so a single shape covers single + repeated
    // use; handoff.joinField folds them back into one ';' string.
    const result = parseArgs(['summary', '--done', 'task A; task B', '--todo', 'task C', '--blocked', 'waiting on API']);
    assert.deepStrictEqual(result.flags, { done: ['task A; task B'], todo: ['task C'], blocked: ['waiting on API'] });
    assert.deepStrictEqual(result.positional, ['summary']);
  });

  // ── repeated multi-flags accumulate (regression) ────────────────────────
  it('accumulates a repeated --done/--todo instead of dropping all but the last', () => {
    // The bug: repeats overwrote, so `--done a --done b` silently lost "a".
    const result = parseArgs(['s', '--done', 'a', '--done', 'b', '--todo', 'c']);
    assert.deepStrictEqual(result.flags, { done: ['a', 'b'], todo: ['c'] });
  });

  it('accumulates repeats given via --flag=value too', () => {
    const result = parseArgs(['--done=a', '--done=b']);
    assert.deepStrictEqual(result.flags, { done: ['a', 'b'] });
  });

  it('does NOT accumulate non-multi flags (last still wins)', () => {
    const result = parseArgs(['--cat', 'x', '--cat', 'y']);
    assert.deepStrictEqual(result.flags, { cat: 'y' });
  });

  it('parses --deep as a boolean flag (pebbl check --deep)', () => {
    const result = parseArgs(['--deep']);
    assert.deepStrictEqual(result.flags, { deep: true });
    assert.deepStrictEqual(result.positional, []);
  });

  it('parses --n as a value flag (pebbl scan-commits --n 50)', () => {
    const result = parseArgs(['--n', '50']);
    assert.deepStrictEqual(result.flags, { n: '50' });
    assert.deepStrictEqual(result.positional, []);
  });

  it('parses handoff boolean flags (--latest, --list, --close)', () => {
    const result = parseArgs(['--latest']);
    assert.deepStrictEqual(result.flags, { latest: true });
    assert.deepStrictEqual(result.positional, []);

    const result2 = parseArgs(['--list']);
    assert.deepStrictEqual(result2.flags, { list: true });

    const result3 = parseArgs(['--close', '--topic', 'auth']);
    assert.deepStrictEqual(result3.flags, { close: true, topic: 'auth' });
  });

  // ── value-flag silent-drop fix ──────────────────────────────────────────
  it('records a value-flag followed by another --flag in missingValueFlags', () => {
    // Previously --corrects was silently dropped here, losing the correction
    // link and leaving the contradicted entry live.
    const result = parseArgs(['m', '--corrects', '--cat', 'decision']);
    assert.deepStrictEqual(result.flags, { cat: 'decision' });
    assert.ok((result.missingValueFlags || []).includes('corrects'),
      'expected corrects in missingValueFlags');
  });

  it('records a trailing value-flag with no following token in missingValueFlags', () => {
    const result = parseArgs(['m', '--corrects']);
    assert.deepStrictEqual(result.flags, {});
    assert.ok((result.missingValueFlags || []).includes('corrects'));
  });

  it('does not record a value-flag that has a value', () => {
    const result = parseArgs(['--corrects', '3']);
    assert.deepStrictEqual(result.flags, { corrects: '3' });
    assert.deepStrictEqual(result.missingValueFlags, []);
  });

  // ── --flag=value syntax ─────────────────────────────────────────────────
  it('parses --flag=value into flags, not content', () => {
    const result = parseArgs(['--cat=decision', 'm']);
    assert.strictEqual(result.flags.cat, 'decision');
    assert.deepStrictEqual(result.positional, ['m']);
  });

  it('splits on the FIRST = so values may contain =', () => {
    const result = parseArgs(['--resolve=22:signal=keep']);
    assert.strictEqual(result.flags.resolve, '22:signal=keep');
  });

  it('treats --flag= (empty inline value) as a missing value', () => {
    const result = parseArgs(['--cat=']);
    assert.strictEqual(result.flags.cat, undefined);
    assert.ok((result.missingValueFlags || []).includes('cat'));
  });

  it('parses boolean flag with inline value: --preview=false turns it off', () => {
    assert.strictEqual(parseArgs(['--preview=false']).flags.preview, false);
    assert.strictEqual(parseArgs(['--preview=0']).flags.preview, false);
    assert.strictEqual(parseArgs(['--preview=true']).flags.preview, true);
    assert.strictEqual(parseArgs(['--preview']).flags.preview, true);
  });

  // ── guardrail: unknown pass-through preserved ────────────────────────────
  it('demotes an unknown flag to positional instead of swallowing it', () => {
    const result = parseArgs(['--nope']);
    assert.deepStrictEqual(result.flags, {});
    assert.deepStrictEqual(result.positional, ['--nope']);
    assert.deepStrictEqual(result.missingValueFlags, []);
  });

  it('--full and --cap are context flags: boolean and value', () => {
    assert.strictEqual(parseArgs(['--full']).flags.full, true);
    assert.deepStrictEqual(parseArgs(['--full']).positional, []);
    assert.strictEqual(parseArgs(['--cap', '800']).flags.cap, '800');
  });

  // ── shared guards ───────────────────────────────────────────────────────
  it('assertCompleteFlags exits 1 when a value-flag is missing its value', () => {
    const { assertCompleteFlags } = require('../src/args');
    const errs = [];
    const exits = [];
    const origErr = console.error;
    const origExit = process.exit;
    console.error = (m) => errs.push(m);
    process.exit = (c) => { exits.push(c); throw new Error('__exit__'); };
    try {
      assertCompleteFlags(parseArgs(['m', '--corrects', '--cat', 'decision']));
    } catch (e) {
      if (e.message !== '__exit__') throw e;
    } finally {
      console.error = origErr;
      process.exit = origExit;
    }
    assert.deepStrictEqual(exits, [1]);
    assert.ok(errs.some(m => /--corrects expects a value/.test(m)));
  });

  it('assertCompleteFlags is a no-op when nothing is missing', () => {
    const { assertCompleteFlags } = require('../src/args');
    let exited = false;
    const origExit = process.exit;
    process.exit = () => { exited = true; };
    try {
      assertCompleteFlags(parseArgs(['--corrects', '3']));
    } finally {
      process.exit = origExit;
    }
    assert.strictEqual(exited, false);
  });

  it('assertIntegerFlags exits 1 on a non-integer --corrects', () => {
    const { assertIntegerFlags } = require('../src/args');
    const errs = [];
    const exits = [];
    const origErr = console.error;
    const origExit = process.exit;
    console.error = (m) => errs.push(m);
    process.exit = (c) => { exits.push(c); throw new Error('__exit__'); };
    try {
      assertIntegerFlags(parseArgs(['m', '--corrects', 'abc']), ['corrects', 'relates']);
    } catch (e) {
      if (e.message !== '__exit__') throw e;
    } finally {
      console.error = origErr;
      process.exit = origExit;
    }
    assert.deepStrictEqual(exits, [1]);
    assert.ok(errs.some(m => /--corrects expects an integer/.test(m)));
  });

  it('assertIntegerFlags allows valid integers and negatives', () => {
    const { assertIntegerFlags } = require('../src/args');
    let exited = false;
    const origExit = process.exit;
    process.exit = () => { exited = true; };
    try {
      assertIntegerFlags(parseArgs(['--corrects', '12', '--relates', '3']), ['corrects', 'relates']);
    } finally {
      process.exit = origExit;
    }
    assert.strictEqual(exited, false);
  });
});
