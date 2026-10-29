'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { splitItems } = require('../src/items');

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
