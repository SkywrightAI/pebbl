'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { splitItems, clipItem } = require('../src/items');

test('splitItems: splits on top-level ;', () => {
  assert.deepStrictEqual(splitItems('a; b ;c'), ['a', 'b', 'c']);
});

test('splitItems: empty / null', () => {
  assert.deepStrictEqual(splitItems(null), []);
  assert.deepStrictEqual(splitItems(''), []);
  assert.deepStrictEqual(splitItems(' ; ; '), []);
});

test('splitItems: keeps ; inside parentheses (proxy-magic handoff #2)', () => {
  const field = "OpenAI key fixed (set-key; the 401 was security's 128-char prompt cut); PRs 24-31 merged";
  assert.deepStrictEqual(splitItems(field), [
    "OpenAI key fixed (set-key; the 401 was security's 128-char prompt cut)",
    'PRs 24-31 merged',
  ]);
});

test('splitItems: keeps ; inside brackets, braces and backticks', () => {
  assert.deepStrictEqual(splitItems('run [a; b]; set {x; y}; `cd a; make`'), [
    'run [a; b]', 'set {x; y}', '`cd a; make`',
  ]);
});

test('splitItems: apostrophes do not open a quote', () => {
  assert.deepStrictEqual(splitItems("owner's call; don't merge"), ["owner's call", "don't merge"]);
});

test('splitItems: double quotes protect ;', () => {
  assert.deepStrictEqual(splitItems('log "a; b"; next'), ['log "a; b"', 'next']);
});

test('splitItems: an unbalanced ) does not swallow the rest', () => {
  assert.deepStrictEqual(splitItems('1) first; 2) second'), ['1) first', '2) second']);
});

test('splitItems: an unclosed ( falls back to plain splitting', () => {
  assert.deepStrictEqual(splitItems('see (note; a; b'), ['see (note', 'a', 'b']);
});

test('clipItem: short items pass through, long ones end in … at exactly max', () => {
  assert.strictEqual(clipItem('short', 160), 'short');
  const long = 'a'.repeat(300);
  assert.strictEqual(clipItem(long, 160).length, 160);
  assert.ok(clipItem(long, 160).endsWith('…'));
  assert.strictEqual(clipItem(null, 10), '');
});

test('clipItem: never leaves a bracket or quote open, so the field still splits right', () => {
  const s = 'fix the gate (see jig for ' + 'x'.repeat(200) + ') and more';
  const out = clipItem(s, 40);
  assert.strictEqual(out, 'fix the gate…');
  assert.deepStrictEqual(splitItems(out + '; next (a; b)'), [out, 'next (a; b)']);
  const q = 'say "hello ' + 'y'.repeat(100);
  assert.strictEqual(clipItem(q, 30), 'say…');
});
