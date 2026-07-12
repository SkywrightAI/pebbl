'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { _internal } = require('../src/check');
const { extractPaths, extractSymbols, extractRepoRoots, checkEntries } = _internal;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-check-'));
const entry = (o) => ({ id: 1, tier: 'detail', timestamp: '2026-06-10T00:00:00Z', category: 'x', ...o });

describe('check - extractPaths', () => {
  it('extracts high-confidence repo-relative path tokens', () => {
    assert.deepEqual(
      extractPaths('fixed in src/foo.js and droplet/repos.conf today').sort(),
      ['droplet/repos.conf', 'src/foo.js']
    );
  });
  it('ignores bare words, URLs, absolute and home paths', () => {
    assert.deepEqual(
      extractPaths('see https://x.com/a.js and /etc/thing.conf and ~/x/y.js and plainword'),
      []
    );
  });
  it('extracts a backtick-wrapped path', () => {
    assert.deepEqual(extractPaths('the `test/check.test.js` file'), ['test/check.test.js']);
  });
  it('skips prose slash-joined filenames (interior segment has an extension)', () => {
    assert.deepEqual(extractPaths('the guardrail in LOOP.md/AGENTS.md is unenforceable'), []);
    assert.deepEqual(extractPaths('probes pyproject.toml/uv.lock anywhere'), []);
  });
});

describe('check - checkEntries (paths)', () => {
  it('flags exactly the entry citing a missing file; spares the present one', () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/present.js'), 'x');
    const entries = [
      entry({ id: 1, tier: 'component', message: 'uses src/present.js for X' }),
      entry({ id: 2, tier: 'foundation', timestamp: '2026-06-11T00:00:00Z', message: 'the gone src/missing.js does Y' }),
    ];
    const flagged = checkEntries(entries, repo);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].id, 2);
    assert.deepEqual(flagged[0].missingPaths, ['src/missing.js']);
  });

  it('orders highest-tier first (foundation outranks fleeting even if older)', () => {
    const repo = tmp();
    const flagged = checkEntries([
      entry({ id: 1, tier: 'fleeting', timestamp: '2026-06-12T00:00:00Z', message: 'gone a/x.js' }),
      entry({ id: 2, tier: 'foundation', timestamp: '2026-06-10T00:00:00Z', message: 'gone b/y.js' }),
    ], repo);
    assert.equal(flagged[0].tier, 'foundation');
  });

  it('symbol-grep is behind --deep: default does not flag a backtick symbol', () => {
    const repo = tmp();
    const entries = [entry({ message: 'calls `nonexistentSymbol()` somewhere' })];
    assert.equal(checkEntries(entries, repo).length, 0);
    assert.deepEqual(extractSymbols(entries[0].message), ['nonexistentSymbol']);
  });

  it('never mutates the input entries', () => {
    const repo = tmp();
    const entries = [entry({ message: 'gone z/q.js' })];
    const before = JSON.stringify(entries);
    checkEntries(entries, repo);
    assert.equal(JSON.stringify(entries), before);
  });
});

describe('check - extractRepoRoots', () => {
  it('extracts an absolute directory path named in the text', () => {
    assert.deepEqual(
      extractRepoRoots('HAROLD (repo /Users/x/Documents/10.Code-Projects/harold, Rust): cites src/lib.rs'),
      ['/Users/x/Documents/10.Code-Projects/harold']
    );
  });
  it('strips trailing sentence punctuation but keeps internal dots', () => {
    assert.deepEqual(
      extractRepoRoots('lives at /Users/x/10.Code-Projects/harold.'),
      ['/Users/x/10.Code-Projects/harold']
    );
  });
  it('skips absolute FILE citations (extension) and URLs; needs 2+ segments', () => {
    assert.deepEqual(
      extractRepoRoots('see /Users/x/repo/src/lib.rs and https://x.com/a/b and /tmp'),
      []
    );
  });
});

describe('check - checkEntries (cross-repo roots)', () => {
  it('does NOT flag a cross-repo entry whose cited file exists in the named repo', () => {
    const store = tmp();                 // the store's own root — file NOT here
    const other = tmp();                 // the repo the entry names — file IS here
    fs.mkdirSync(path.join(other, 'src'));
    fs.writeFileSync(path.join(other, 'src/lib.rs'), 'x');
    const entries = [entry({ message: `HAROLD (repo ${other}, Rust): core in src/lib.rs` })];
    assert.equal(checkEntries(entries, store).length, 0, 'exists in the named repo → not missing');
  });

  it('flags a cross-repo entry whose cited file exists in NEITHER root', () => {
    const store = tmp();
    const other = tmp();                 // named repo exists but the file is gone
    const entries = [entry({ message: `HAROLD (repo ${other}, Rust): core in src/lib.rs` })];
    const flagged = checkEntries(entries, store);
    assert.equal(flagged.length, 1, 'missing everywhere → still flagged');
    assert.deepEqual(flagged[0].missingPaths, ['src/lib.rs']);
  });

  it('same-repo entries (no named root) behave exactly as before', () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/present.js'), 'x');
    const flagged = checkEntries([
      entry({ id: 1, message: 'uses src/present.js for X' }),
      entry({ id: 2, message: 'the gone src/missing.js does Y' }),
    ], repo);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].id, 2);
    assert.deepEqual(flagged[0].missingPaths, ['src/missing.js']);
  });

  it('a named path that is not a real directory adds nothing (still flagged)', () => {
    const store = tmp();
    const entries = [entry({ message: 'repo /no/such/dir-anywhere cites src/gone.js' })];
    const flagged = checkEntries(entries, store);
    assert.equal(flagged.length, 1);
  });

  it('resolves a src/-shorthand citation against the named root src/ dir', () => {
    const store = tmp();
    const other = tmp();
    fs.mkdirSync(path.join(other, 'src/capabilities'), { recursive: true });
    fs.writeFileSync(path.join(other, 'src/capabilities/claim.js'), 'x');
    // cited WITHOUT the src/ prefix — the named root's layout covers it
    const entries = [entry({ message: `SELF-FIX (repo at ${other}): reuse capabilities/claim.js` })];
    assert.equal(checkEntries(entries, store).length, 0);
  });

  it("resolves a src/-shorthand citation against the store's OWN repo src/ dir", () => {
    // The loom-triage false positive: the store's own entries cite
    // "capabilities/queue.js" for src/capabilities/queue.js, naming no root.
    const repo = tmp();
    fs.mkdirSync(path.join(repo, 'src/capabilities'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/capabilities/queue.js'), 'x');
    const entries = [entry({ message: 'single queue impl (capabilities/queue.js: addTask/nextTask)' })];
    assert.equal(checkEntries(entries, repo).length, 0, 'exists under own src/ → not missing');
  });

  it('a citation missing from BOTH the own root and its src/ is still flagged', () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, 'src'));
    const entries = [entry({ message: 'the gone capabilities/vanished.js does Y' })];
    const flagged = checkEntries(entries, repo);
    assert.equal(flagged.length, 1, 'missing under root AND src/ → flagged');
    assert.deepEqual(flagged[0].missingPaths, ['capabilities/vanished.js']);
  });

  it('a repo with no src/ dir keeps plain own-root resolution (no phantom root)', () => {
    const repo = tmp(); // no src/ subdir at all
    fs.writeFileSync(path.join(repo, 'present.js'), 'x');
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.writeFileSync(path.join(repo, 'lib/here.js'), 'x');
    const flagged = checkEntries([
      entry({ id: 1, message: 'uses lib/here.js for X' }),
      entry({ id: 2, message: 'the gone lib/gone.js does Y' }),
    ], repo);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].id, 2);
  });
});

describe('check - --deep symbol grep (git-backed)', () => {
  it('flags a missing symbol and spares a present one under deep', () => {
    const repo = tmp();
    const git = (c) => execSync(c, { cwd: repo, stdio: 'ignore' });
    git('git init -q');
    git('git config user.email t@t.invalid');
    git('git config user.name t');
    fs.writeFileSync(path.join(repo, 'code.js'), 'function presentSym() { return 1; }\n');
    git('git add -A');
    git('git commit -qm init');
    const present = checkEntries([entry({ message: 'uses `presentSym()` here' })], repo, { deep: true });
    assert.equal(present.length, 0, 'present symbol must not be flagged');
    const absent = checkEntries([entry({ message: 'uses `absentSym()` here' })], repo, { deep: true });
    assert.equal(absent.length, 1, 'absent symbol must be flagged under --deep');
    assert.deepEqual(absent[0].missingSymbols, ['absentSym']);
  });
});
