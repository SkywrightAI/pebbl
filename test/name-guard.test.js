'use strict';
// The name remover. The failure it exists for: four entries in a real store name
// a real user, written months before anyone noticed, and append-only memory
// cannot take them back. Every guard pebbl had ran too late — the pre-commit
// scan can refuse the COMMIT, but by then the text is already in events.jsonl.
//
// So the property under test is that substitution happens BEFORE the store is
// touched, and that it is total: a half-anonymised name reads as anonymised,
// which is worse than none.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { substituteNames, nameGuardMode } = require('../src/name-guard');
const { loadNameMap } = require('../src/privacy-scan');
const BIN = path.resolve(__dirname, '../bin/pebbl.js');

const MAP = { 'Cordelia Vance': 'Rowan Ashford', Cordelia: 'Rowan', 'Aurora Pictures Inc': 'Meridian Pictures Inc' };

describe('name-guard — substitution', () => {
  it('replaces a mapped name with its pseudonym', () => {
    const { text, subs } = substituteNames('met with Cordelia Vance today', MAP);
    assert.equal(text, 'met with Rowan Ashford today');
    assert.equal(subs[0].real, 'Cordelia Vance');
  });

  it('prefers the LONGEST match, so no bare surname survives', () => {
    // "Cordelia" alone is also mapped. If the short key won, the text would keep
    // "Vance" — real PII left behind in something that looks anonymised.
    const { text } = substituteNames('Cordelia Vance signed', MAP);
    assert.equal(text, 'Rowan Ashford signed');
    assert.ok(!/Vance/.test(text));
  });

  it('replaces EVERY mention, including adjacent ones', () => {
    // Overlapping boundary groups mean a single regex pass misses the second of
    // two adjacent mentions: the first match consumes the separator.
    const { text, subs } = substituteNames('Cordelia and Cordelia again', MAP);
    assert.equal(text, 'Rowan and Rowan again');
    assert.equal(subs.find((s) => s.real === 'Cordelia').count, 2);
  });

  it('is case-insensitive but leaves unrelated words alone', () => {
    const { text } = substituteNames('CORDELIA and accordion', MAP);
    assert.match(text, /ROWAN/, 'the pseudonym follows the case it matched');
    assert.match(text, /accordion/, 'a substring inside another word is not a mention');
  });

  it('is a no-op with an empty map, and never throws on null', () => {
    assert.equal(substituteNames('Cordelia Vance', {}).text, 'Cordelia Vance');
    assert.deepEqual(substituteNames(null, MAP).subs, []);
  });

  it('reports what it changed, so nothing is rewritten silently', () => {
    const { subs } = substituteNames('Cordelia Vance met Aurora Pictures Inc', MAP);
    assert.equal(subs.length, 2);
    assert.ok(subs.every((s) => s.real && s.pseudonym && s.count > 0));
  });
});

describe('name-guard — mode', () => {
  it('defaults to substitute, and an unrecognized value falls back to it', () => {
    const prev = process.env.PEBBL_NAME_GUARD;
    try {
      delete process.env.PEBBL_NAME_GUARD;
      assert.equal(nameGuardMode(), 'substitute');
      process.env.PEBBL_NAME_GUARD = 'wibble';
      assert.equal(nameGuardMode(), 'substitute', 'a typo must never silently disable it');
      process.env.PEBBL_NAME_GUARD = 'off';
      assert.equal(nameGuardMode(), 'off');
    } finally {
      if (prev === undefined) delete process.env.PEBBL_NAME_GUARD;
      else process.env.PEBBL_NAME_GUARD = prev;
    }
  });
});

describe('name-guard — loadNameMap', () => {
  function withMap(contents) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-nm-'));
    fs.writeFileSync(path.join(d, 'name-map.json'), contents);
    return d;
  }
  it('reads the anon tool shape [{real, pseudonym}]', () => {
    const d = withMap(JSON.stringify([{ real: 'Cordelia Vance', pseudonym: 'Rowan Ashford', type: 'person' }]));
    assert.equal(loadNameMap({ repoRoot: d })['Cordelia Vance'], 'Rowan Ashford');
  });
  it('reads a flat {real: pseudonym} map', () => {
    const d = withMap(JSON.stringify({ 'Cordelia Vance': 'Rowan Ashford' }));
    assert.equal(loadNameMap({ repoRoot: d })['Cordelia Vance'], 'Rowan Ashford');
  });
  it('returns {} for a malformed map instead of throwing', () => {
    assert.deepEqual(loadNameMap({ repoRoot: withMap('{ not json') }), {});
  });
  it('drops keys too short to be a real name', () => {
    const d = withMap(JSON.stringify({ ab: 'X', 'Cordelia Vance': 'Rowan Ashford' }));
    const m = loadNameMap({ repoRoot: d });
    assert.ok(!('ab' in m), 'a two-letter key would carpet-match the corpus');
  });
});

// ── end to end: the name must never reach the store ─────────────────────────

describe('pebbl log — the name never enters the append-only store', () => {
  function storeWithMap() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-ng-'));
    execFileSync('bash', ['-c', 'git init -q && git config user.email t@t && git config user.name t'], { cwd: repo, stdio: 'ignore' });
    execFileSync('node', [BIN, 'init'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, '.pebbl', 'name-map.json'),
      JSON.stringify([{ real: 'Cordelia Vance', pseudonym: 'Rowan Ashford', type: 'person' }]));
    return repo;
  }

  it('substitutes before the write, so events.jsonl never contains the real name', () => {
    const repo = storeWithMap();
    const out = execFileSync('node', [BIN, 'log', 'shipped the fix with Cordelia Vance', '--cat', 'decision'], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(out, /Rowan Ashford/, 'the stored entry carries the pseudonym');

    // The whole point: not just the projection, the canonical log too.
    for (const f of ['events.jsonl', 'manual-logs.md']) {
      const p = path.join(repo, '.pebbl', f);
      if (!fs.existsSync(p)) continue;
      const body = fs.readFileSync(p, 'utf8');
      assert.ok(!body.includes('Cordelia Vance'), `${f} must not contain the real name`);
      assert.ok(body.includes('Rowan Ashford'), `${f} should carry the pseudonym`);
    }
  });

  it('leaves an entry with no mapped name byte-identical', () => {
    const repo = storeWithMap();
    execFileSync('node', [BIN, 'log', 'chose bcrypt over argon2', '--cat', 'decision'], { cwd: repo, stdio: 'ignore' });
    const body = fs.readFileSync(path.join(repo, '.pebbl', 'events.jsonl'), 'utf8');
    assert.ok(body.includes('chose bcrypt over argon2'));
  });

  it('is a no-op in a store with no name-map (the common case)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-nn-'));
    execFileSync('bash', ['-c', 'git init -q && git config user.email t@t && git config user.name t'], { cwd: repo, stdio: 'ignore' });
    execFileSync('node', [BIN, 'init'], { cwd: repo, stdio: 'ignore' });
    execFileSync('node', [BIN, 'log', 'worked with Cordelia Vance', '--cat', 'decision'], { cwd: repo, stdio: 'ignore' });
    const body = fs.readFileSync(path.join(repo, '.pebbl', 'events.jsonl'), 'utf8');
    assert.ok(body.includes('Cordelia Vance'), 'no map means no substitution — and no crash');
  });
});

describe('name-guard — case follows the match', () => {
  const { substituteNames } = require('../src/name-guard');
  const M = { Gabriel: 'Rowan' };

  it('a lowercase mention (a username) yields a lowercase pseudonym', () => {
    // Without this, "droplet user gabriel" becomes "droplet user Rowan" — reads
    // as a person where the text meant an account. Matching is case-insensitive,
    // so a map cannot hold case-distinct entries for the same name.
    assert.equal(substituteNames('droplet user gabriel', M).text, 'droplet user rowan');
  });

  it('a capitalised mention keeps the map spelling', () => {
    assert.equal(substituteNames('met Gabriel today', M).text, 'met Rowan today');
  });

  it('a SHOUTED mention is uppercased', () => {
    assert.equal(substituteNames('ping GABRIEL now', M).text, 'ping ROWAN now');
  });

  it('one map entry now covers every casing', () => {
    const { text } = substituteNames('Gabriel, gabriel and GABRIEL', M);
    assert.ok(!/gabriel/i.test(text), 'no casing of the real name survives');
  });
});
