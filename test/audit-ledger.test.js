'use strict';
// The accept ledger: the operator's durable rotate-vs-accept decisions.
//
// The property under test throughout is the one that motivated the ledger:
// an ACCEPTED historical finding stops blocking, a NEW finding still blocks.
// A ledger that failed either half would be worse than no ledger — the first
// re-creates the deadlock, the second silently disarms the gate.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ledgerMod = require('../src/audit-ledger');
const {
  fingerprint, loadLedger, saveLedger, toEntry, partition, groupByFingerprint, resolveId,
  LEDGER_FILENAME,
} = ledgerMod;

const BIN = path.resolve(__dirname, '../bin/pebbl.js');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-ledger-'));
}
function sh(repo, cmd) {
  execFileSync('bash', ['-c', cmd], { cwd: repo, stdio: 'ignore' });
}
function run(repo, args, env = {}) {
  return execFileSync('node', [BIN, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const F_IP = { class: 'network', file: 'notes/a.md', match: '198.18.0.7:8080', detail: 'public host:port', line: 3, commit: 'aaaaaaaaaaaa' }; // allowlist-secret: reserved-range fixture, not real infrastructure
const F_PATH = { class: 'cred-path', file: 'notes/a.md', match: '/root/.claude-env', detail: 'credential file path', line: 4, commit: 'aaaaaaaaaaaa' }; // allowlist-secret: fixture path, not a credential

describe('audit-ledger — fingerprint identity', () => {
  it('is stable for the same class+file+match', () => {
    assert.equal(fingerprint(F_IP), fingerprint({ ...F_IP }));
  });

  it('IGNORES the commit and line — one string in one file is ONE decision', () => {
    // This is the whole fix. Keying on commit would mint a new un-accepted
    // fingerprint on the next commit touching the file and re-deadlock the gate.
    const sameStringLaterCommit = { ...F_IP, commit: 'ffffffffffff', line: 99 };
    assert.equal(fingerprint(F_IP), fingerprint(sameStringLaterCommit));
  });

  it('differs when the leaked string differs', () => {
    assert.notEqual(fingerprint(F_IP), fingerprint({ ...F_IP, match: '198.18.0.8:8080' })); // allowlist-secret: reserved-range fixture, not real infrastructure
  });

  it('differs when the same string appears in a different file', () => {
    assert.notEqual(fingerprint(F_IP), fingerprint({ ...F_IP, file: 'notes/b.md' }));
  });
});

describe('audit-ledger — partition', () => {
  it('routes accepted findings out of the blocking set', () => {
    const map = new Map([[fingerprint(F_IP), toEntry(F_IP, 'already public', 'now')]]);
    const { blocking, accepted } = partition([F_IP, F_PATH], map);
    assert.equal(accepted.length, 1);
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].class, 'cred-path');
  });

  it('still blocks a NEW finding after an accept — the gate keeps its teeth', () => {
    const map = new Map([[fingerprint(F_IP), toEntry(F_IP, 'already public', 'now')]]);
    const brandNew = { class: 'token', file: 'notes/new.md', match: 'AKIAIOSFODNN7EXAMPLE', detail: 'token shape', line: 1, commit: 'bbbbbbbbbbbb' }; // allowlist-secret: AWS's own documented example key
    const { blocking } = partition([F_IP, brandNew], map);
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].match, 'AKIAIOSFODNN7EXAMPLE'); // allowlist-secret: AWS's own documented example key
  });

  it('accepts every commit of the same string at once', () => {
    const map = new Map([[fingerprint(F_IP), toEntry(F_IP, 'r', 'now')]]);
    const across = [F_IP, { ...F_IP, commit: 'cccccccccccc' }, { ...F_IP, commit: 'dddddddddddd' }];
    const { blocking, accepted } = partition(across, map);
    assert.equal(blocking.length, 0);
    assert.equal(accepted.length, 3);
  });
});

describe('audit-ledger — a token-class accept never writes the secret down', () => {
  it('omits `match` for the token class', () => {
    // The ledger is a COMMITTED file. Recording the raw match for a token-shaped
    // finding would commit the secret we are containing.
    const tok = { class: 'token', file: 'notes/a.md', match: 'sk-ant-oat01-REALLOOKINGVALUE', detail: 'token shape', line: 1, commit: 'aaaaaaaaaaaa' }; // allowlist-secret: deliberately fake
    const entry = toEntry(tok, 'dead fixture', 'now');
    assert.equal(entry.match, undefined);
    assert.ok(!JSON.stringify(entry).includes('sk-ant-oat01'));
    // …and it is still matchable, because matching goes through the hash.
    const { accepted } = partition([tok], new Map([[entry.id, entry]]));
    assert.equal(accepted.length, 1);
  });

  it('keeps `match` for the non-secret classes so the ledger stays readable', () => {
    assert.equal(toEntry(F_PATH, 'r', 'now').match, '/root/.claude-env'); // allowlist-secret: fixture path
  });
});

describe('audit-ledger — fail closed', () => {
  it('accepts nothing and reports an error when the ledger is corrupt', () => {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, LEDGER_FILENAME), '{ this is not json');
    const l = loadLedger(repo);
    assert.equal(l.accepted.size, 0);
    assert.ok(l.error, 'a corrupt ledger must report an error, not read as empty');
  });

  it('accepts nothing when the ledger has the wrong shape', () => {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, LEDGER_FILENAME), JSON.stringify({ version: 1, accepted: 'everything' }));
    const l = loadLedger(repo);
    assert.equal(l.accepted.size, 0);
    assert.ok(l.error);
  });

  it('treats an absent ledger as empty WITHOUT an error', () => {
    const l = loadLedger(tmpRepo());
    assert.equal(l.accepted.size, 0);
    assert.equal(l.error, null);
  });

  it('round-trips through save/load', () => {
    const repo = tmpRepo();
    saveLedger(repo, new Map([[fingerprint(F_IP), toEntry(F_IP, 'already public', '2026-07-30T00:00:00Z')]]));
    const l = loadLedger(repo);
    assert.equal(l.error, null);
    assert.equal(l.accepted.get(fingerprint(F_IP)).reason, 'already public');
  });

  it('writes a byte-stable file so a no-op re-save produces an empty diff', () => {
    const repo = tmpRepo();
    const a = new Map([
      [fingerprint(F_PATH), toEntry(F_PATH, 'r', 't')],
      [fingerprint(F_IP), toEntry(F_IP, 'r', 't')],
    ]);
    saveLedger(repo, a);
    const first = fs.readFileSync(path.join(repo, LEDGER_FILENAME), 'utf8');
    saveLedger(repo, loadLedger(repo).accepted);
    assert.equal(fs.readFileSync(path.join(repo, LEDGER_FILENAME), 'utf8'), first);
  });
});

describe('audit-ledger — id resolution refuses to guess', () => {
  it('resolves an unambiguous prefix', () => {
    assert.equal(resolveId('ab', ['abcdef', 'ffffff']).id, 'abcdef');
  });
  it('errors on an ambiguous prefix rather than picking one', () => {
    const r = resolveId('ab', ['abcdef', 'abc123']);
    assert.equal(r.id, null);
    assert.match(r.error, /ambiguous/);
  });
  it('errors on an unknown prefix', () => {
    assert.match(resolveId('zz', ['abcdef']).error, /no finding matches/);
  });
});

describe('audit-ledger — groupByFingerprint', () => {
  it('collapses the same string across commits into one row', () => {
    const groups = groupByFingerprint([F_IP, { ...F_IP, commit: 'cccccccccccc' }, F_PATH]);
    assert.equal(groups.length, 2);
    const ipGroup = groups.find((g) => g.class === 'network');
    assert.equal(ipGroup.commits.length, 2);
  });
});

// ── end-to-end through the real CLI + a real git repo ────────────────────────

function repoWithLeak() {
  const repo = tmpRepo();
  sh(repo, 'git init -q && git config user.email t@t && git config user.name t');
  fs.mkdirSync(path.join(repo, 'notes'));
  fs.writeFileSync(path.join(repo, 'notes/a.md'), 'droplet 198.18.0.7:8080 cred /root/.claude-env\n'); // allowlist-secret: fixture path
  sh(repo, 'git add -A && git commit -qm leak');
  return repo;
}

describe('audit-history CLI — accept flow', () => {
  it('lists findings with ids, then accepts one and drops it from the checklist', () => {
    const repo = repoWithLeak();
    const before = run(repo, ['audit-history']);
    assert.match(before, /unaccepted potential leak/);
    const id = /\(id ([0-9a-f]{12})\)/.exec(before)[1];

    run(repo, ['audit-history', '--accept', id, '--reason', 'already public, service is dead']);

    const after = run(repo, ['audit-history']);
    assert.ok(!after.includes(`(id ${id})`), 'an accepted finding must leave the blocking checklist');
    assert.match(after, /already accepted/);
  });

  it('refuses --accept without --reason', () => {
    const repo = repoWithLeak();
    const id = /\(id ([0-9a-f]{12})\)/.exec(run(repo, ['audit-history']))[1];
    assert.throws(
      () => run(repo, ['audit-history', '--accept', id]),
      (e) => /requires --reason/.test(String(e.stderr)),
    );
  });

  it('--accept all clears the checklist and records a reason for each', () => {
    const repo = repoWithLeak();
    run(repo, ['audit-history', '--accept', 'all', '--reason', 'reviewed 2026-07-30']);
    assert.match(run(repo, ['audit-history']), /no UNACCEPTED leak/);
    const listed = run(repo, ['audit-history', '--list-accepted']);
    assert.match(listed, /reviewed 2026-07-30/);
    assert.match(listed, /198\.18\.0\.7:8080/);
  });

  it('--revoke puts a finding back in the blocking set', () => {
    const repo = repoWithLeak();
    run(repo, ['audit-history', '--accept', 'all', '--reason', 'x']);
    const id = /^\s+([0-9a-f]{12})\s+\[/m.exec(run(repo, ['audit-history', '--list-accepted']))[1];
    run(repo, ['audit-history', '--revoke', id]);
    assert.match(run(repo, ['audit-history']), new RegExp(`\\(id ${id}\\)`));
  });

  it('writes the ledger to the git root, not to a symlinked .pebbl parent', () => {
    const repo = repoWithLeak();
    run(repo, ['audit-history', '--accept', 'all', '--reason', 'x']);
    assert.ok(fs.existsSync(path.join(repo, LEDGER_FILENAME)));
  });
});

describe('privacy-scan --push — the deadlock is gone but the gate is not', () => {
  function publicRepo() {
    const repo = repoWithLeak();
    sh(repo, 'git remote add origin https://github.com/example/example.git');
    return repo;
  }
  const PUBLIC = { PEBBL_REMOTE_VISIBILITY: 'public', PEBBL_GH_VISIBILITY: 'public' };

  it('blocks a public push while findings are unaccepted', () => {
    assert.throws(
      () => run(publicRepo(), ['privacy-scan', '--push'], PUBLIC),
      (e) => /BLOCKED/.test(String(e.stderr)),
    );
  });

  it('ALLOWS the push once every finding is accepted', () => {
    const repo = publicRepo();
    run(repo, ['audit-history', '--accept', 'all', '--reason', 'already published, cannot be un-leaked']);
    // Throws on non-zero exit; reaching the assert means the gate let it through.
    run(repo, ['privacy-scan', '--push'], PUBLIC);
    assert.ok(true);
  });

  it('blocks again the moment a NEW leak lands, even with a full ledger', () => {
    const repo = publicRepo();
    run(repo, ['audit-history', '--accept', 'all', '--reason', 'reviewed']);
    fs.writeFileSync(path.join(repo, 'notes/b.md'), 'new leak 198.18.0.9:443\n'); // allowlist-secret: reserved-range fixture, not real infrastructure
    sh(repo, 'git add -A && git commit -qm "new leak"');
    assert.throws(
      () => run(repo, ['privacy-scan', '--push'], PUBLIC),
      (e) => /BLOCKED/.test(String(e.stderr)) && /198\.18\.0\.9/.test(String(e.stderr)),
    );
  });

  it('fails CLOSED on a corrupt ledger — a broken accept-list must not disarm the gate', () => {
    const repo = publicRepo();
    run(repo, ['audit-history', '--accept', 'all', '--reason', 'reviewed']);
    fs.writeFileSync(path.join(repo, LEDGER_FILENAME), '{{{ corrupt');
    assert.throws(
      () => run(repo, ['privacy-scan', '--push'], PUBLIC),
      (e) => /BLOCKED/.test(String(e.stderr)) && /unreadable/.test(String(e.stderr)),
    );
  });
});

describe('privacy-scan --staged — the ledger can commit itself', () => {
  function stagedRepo(files) {
    const repo = tmpRepo();
    sh(repo, 'git init -q && git config user.email t@t && git config user.name t');
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    sh(repo, 'git add -A && git commit -qm seed');
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), body);
    }
    sh(repo, 'git add -A');
    return repo;
  }

  it('does NOT block on the ledger, whose job is to record matched strings', () => {
    // Without the exemption the ledger is uncommittable: it stores the very
    // strings it exempts, so the pre-commit scan re-flags every accept.
    const repo = stagedRepo({
      [LEDGER_FILENAME]: JSON.stringify({
        version: 1,
        accepted: [{ id: 'abc123abc123', class: 'network', file: 'notes/a.md', match: '198.18.0.7:8080', reason: 'dead', acceptedAt: 'now' }], // allowlist-secret: reserved-range fixture, not real infrastructure
      }, null, 2),
    });
    run(repo, ['privacy-scan', '--staged']);
    assert.ok(true, 'staging the ledger must not block the commit');
  });

  it('still blocks a leak in a normal file, and names that file', () => {
    const repo = stagedRepo({ 'notes/b.md': 'leak 198.18.0.77:1234\n' }); // allowlist-secret: reserved-range fixture, not real infrastructure
    assert.throws(
      () => run(repo, ['privacy-scan', '--staged']),
      (e) => /BLOCKED/.test(String(e.stderr)) && /notes\/b\.md/.test(String(e.stderr)),
    );
  });

  it('exempts ONLY the exact root path — a look-alike elsewhere is still scanned', () => {
    // The exemption must not be smugglable by naming a file cleverly.
    const repo = stagedRepo({
      [`notes/${LEDGER_FILENAME}`]: JSON.stringify({ accepted: [{ match: '198.18.0.88:1234' }] }), // allowlist-secret: reserved-range fixture, not real infrastructure
    });
    assert.throws(
      () => run(repo, ['privacy-scan', '--staged']),
      (e) => /BLOCKED/.test(String(e.stderr)),
    );
  });
});

describe('privacy-scan --staged — one ledger, two producers of findings', () => {
  function stagedRepo(files) {
    const repo = tmpRepo();
    sh(repo, 'git init -q && git config user.email t@t && git config user.name t');
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    sh(repo, 'git add -A && git commit -qm seed');
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), body);
    }
    sh(repo, 'git add -A');
    return repo;
  }
  // A machine-written append-only log can legitimately RECORD a credential path,
  // and cannot be hand-edited to carry a line marker. Without a ledger the only
  // escape is PEBBL_SKIP_SCAN, which disables the scan for the whole commit.
  const LOGLINE = '{"type":"append","message":"loom reads secrets from /.config/loom/secrets.env"}\n'; // allowlist-secret: fixture path, not a credential

  it('blocks a staged credential path before any decision is recorded', () => {
    assert.throws(
      () => run(stagedRepo({ '.pebbl/events.jsonl': LOGLINE }), ['privacy-scan', '--staged']),
      (e) => /BLOCKED/.test(String(e.stderr)),
    );
  });

  it('--accept all --reason records it and the same content then passes', () => {
    const repo = stagedRepo({ '.pebbl/events.jsonl': LOGLINE });
    const out = run(repo, ['privacy-scan', '--staged', '--accept', 'all', '--reason', 'a credential PATH is not a credential']);
    assert.match(out, /accepted [0-9a-f]{12}/);
    run(repo, ['privacy-scan', '--staged']);   // throws on non-zero exit
    assert.ok(fs.existsSync(path.join(repo, LEDGER_FILENAME)));
  });

  it('refuses --accept without --reason', () => {
    assert.throws(
      () => run(stagedRepo({ '.pebbl/events.jsonl': LOGLINE }), ['privacy-scan', '--staged', '--accept', 'all']),
      (e) => /requires --reason/.test(String(e.stderr)),
    );
  });

  it('an accept is scoped to that file — the same string elsewhere still blocks', () => {
    const repo = stagedRepo({ '.pebbl/events.jsonl': LOGLINE });
    run(repo, ['privacy-scan', '--staged', '--accept', 'all', '--reason', 'path not credential']);
    fs.writeFileSync(path.join(repo, 'notes.md'), 'source /.config/loom/secrets.env\n'); // allowlist-secret: fixture path, not a credential
    sh(repo, 'git add -A');
    assert.throws(
      () => run(repo, ['privacy-scan', '--staged']),
      (e) => /BLOCKED/.test(String(e.stderr)) && /notes\.md/.test(String(e.stderr)),
    );
  });

  it('a NEW leak class in the accepted file still blocks', () => {
    const repo = stagedRepo({ '.pebbl/events.jsonl': LOGLINE });
    run(repo, ['privacy-scan', '--staged', '--accept', 'all', '--reason', 'path not credential']);
    fs.appendFileSync(path.join(repo, '.pebbl/events.jsonl'), '{"message":"host 198.18.0.9:443"}\n'); // allowlist-secret: fixture path, not a credential
    sh(repo, 'git add -A');
    assert.throws(
      () => run(repo, ['privacy-scan', '--staged']),
      (e) => /BLOCKED/.test(String(e.stderr)) && /198\.18\.0\.9/.test(String(e.stderr)),
    );
  });
});
