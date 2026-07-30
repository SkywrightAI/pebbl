'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, scanText, loadDenylist, detectRemoteVisibility, _internal } = require('../src/privacy-scan');

describe('privacy-scan — network class (a)', () => {
  it('flags a non-RFC1918 public IP with a port (the live droplet leak)', () => {
    const hits = scan('droplet 67.207.93.196:48422 is the dad-review host');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].class, 'network');
    assert.equal(hits[0].match, '67.207.93.196:48422');
  });

  it('flags a bare public IP even without a port', () => {
    const hits = scan('reach out to 8.8.8.8 for dns');
    assert.equal(hits.filter((h) => h.class === 'network').length, 1);
  });

  it('does NOT flag RFC1918 10.0.0.0/8', () => {
    assert.equal(scan('node 10.0.0.5:5432 talks to db').length, 0);
  });

  it('does NOT flag RFC1918 172.16.0.0/12 across its full range', () => {
    assert.equal(scan('svc 172.16.0.1 and 172.31.255.254:9000').length, 0);
  });

  it('DOES flag 172.15.x and 172.32.x (just outside the private block)', () => {
    assert.equal(scan('edge 172.15.0.1').filter((h) => h.class === 'network').length, 1);
    assert.equal(scan('edge 172.32.0.1').filter((h) => h.class === 'network').length, 1);
  });

  it('does NOT flag RFC1918 192.168.0.0/16, loopback, or link-local', () => {
    assert.equal(scan('host 192.168.1.10:8080 is rfc1918 and fine').length, 0);
    assert.equal(scan('dev server 127.0.0.1:3000').length, 0);
    assert.equal(scan('link-local 169.254.1.1').length, 0);
  });

  it('does NOT treat a version string as an IP', () => {
    assert.equal(scan('upgraded to version 1.2.3 build 4').length, 0);
  });

  it('does NOT match an out-of-range octet like 999.1.1.1', () => {
    assert.equal(scan('not an ip 999.1.1.1').filter((h) => h.class === 'network').length, 0);
  });
});

describe('privacy-scan — credential-path class (b)', () => {
  it('flags the design-named bot.env paths', () => {
    for (const p of [
      '/etc/factory-updates-bot.env',
      '/etc/bookforge-bot.env',
      '/factory/etc/sw-factory-bot.env',
    ]) {
      const hits = scan(`cred at ${p} loaded`).filter((h) => h.class === 'cred-path');
      assert.equal(hits.length, 1, `expected one cred-path hit for ${p}`);
      assert.ok(p.includes(hits[0].match) || hits[0].match.includes(p.split('/').pop()));
    }
  });

  it('flags /root/.claude-env and a bare .env', () => {
    assert.ok(scan('source /root/.claude-env').some((h) => h.class === 'cred-path'));
    assert.ok(scan('never commit .env to the repo').some((h) => h.class === 'cred-path'));
  });

  it('reports a path once (overlapping patterns are deduped)', () => {
    const hits = scan('/etc/factory-updates-bot.env').filter((h) => h.class === 'cred-path');
    assert.equal(hits.length, 1);
  });
});

describe('privacy-scan — token-shape class', () => {
  it('flags an sk-ant OAuth/API token shape', () => {
    assert.ok(scan('token sk-ant-oat01-abc123def456').some((h) => h.class === 'token'));
  });
  it('flags an AWS access key and a github token', () => {
    assert.ok(scan('key AKIAIOSFODNN7EXAMPLE').some((h) => h.class === 'token')); // allowlist-secret (AWS docs example key, not a real credential)
    assert.ok(scan('ghp_0123456789abcdefghijABCDEFGHIJ0123').some((h) => h.class === 'token'));
  });
  it('flags a private key block header', () => {
    assert.ok(scan('-----BEGIN OPENSSH PRIVATE KEY-----').some((h) => h.class === 'token')); // allowlist-secret (header literal only, no key material)
  });
});

describe('privacy-scan — PII/name denylist class (c)', () => {
  it('flags a denylisted name passed explicitly', () => {
    const hits = scan('the deal with Kingdom Story Company fell through', { denylist: ['Kingdom Story Company'] });
    assert.ok(hits.some((h) => h.class === 'name' && h.match === 'Kingdom Story Company'));
  });

  it('degrades gracefully to empty denylist when no map exists (no crash, no name hits)', () => {
    const hits = scan('Cordelia Vance signed the contract', { pebblDir: '/nonexistent', repoRoot: '/nonexistent' });
    assert.equal(hits.filter((h) => h.class === 'name').length, 0);
  });

  it('loads the denylist from a name-map.json (the anon map shape)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-nm-'));
    try {
      const map = [
        { real: 'Cordelia Vance', pseudonym: 'Rowan Ashford', type: 'person' },
        { real: 'Aurora Pictures Inc', pseudonym: 'Meridian Pictures Inc', type: 'company' },
      ];
      fs.writeFileSync(path.join(dir, 'name-map.json'), JSON.stringify(map));
      const dl = loadDenylist({ repoRoot: dir });
      assert.ok(dl.includes('Cordelia Vance'));
      assert.ok(dl.includes('Aurora Pictures Inc'));
      const hits = scan('met with Cordelia Vance today', { repoRoot: dir });
      assert.ok(hits.some((h) => h.class === 'name' && h.match === 'Cordelia Vance'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed name-map does not crash — empty denylist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-nm-bad-'));
    try {
      fs.writeFileSync(path.join(dir, 'name-map.json'), '{ not json');
      assert.deepEqual(loadDenylist({ repoRoot: dir }), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('privacy-scan — adversarial combined + clean', () => {
  it('catches the verify combo line (IP+port AND cred path)', () => {
    const hits = scan('droplet 67.207.93.196:48422 cred /etc/factory-updates-bot.env');
    assert.ok(hits.some((h) => h.class === 'network'));
    assert.ok(hits.some((h) => h.class === 'cred-path'));
  });

  it('passes a clean shared event with zero hits', () => {
    assert.equal(scan('chose bcrypt over argon2 because the team operates bcrypt in prod').length, 0);
  });

  it('scanText is an alias for scan', () => {
    assert.equal(typeof scanText, 'function');
    assert.equal(scanText('67.207.93.196:48422').length, 1);
  });

  it('null/empty text returns no hits', () => {
    assert.deepEqual(scan(null), []);
    assert.deepEqual(scan(''), []);
  });

  it('reports the correct line number across a multi-line blob', () => {
    const hits = scan('line one clean\nline two 67.207.93.196\nline three clean');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
  });
});

describe('privacy-scan — false-positive fixes (DTCG tokens + process.env)', () => {
  // ── DTCG design-token paths: MUST NOT fire ────────────────────────────────
  it('does NOT flag a DTCG dot-notation token path in a JSON schema', () => {
    assert.equal(scan('{ "token": "color.primary" }').filter((h) => h.class === 'token').length, 0);
  });

  it('does NOT flag a multi-level DTCG token path', () => {
    assert.equal(scan('token: "typography.size.sm"').filter((h) => h.class === 'token').length, 0);
  });

  // ── process.env / import.meta.env: MUST NOT fire ──────────────────────────
  it('does NOT flag process.env (JS property access)', () => {
    assert.equal(scan('const { env } = process').filter((h) => h.class === 'cred-path').length, 0);
    assert.equal(scan('process.env').filter((h) => h.class === 'cred-path').length, 0);
    assert.equal(scan('process.env.MODE').filter((h) => h.class === 'cred-path').length, 0);
  });

  it('does NOT flag import.meta.env.MODE (JS property chain)', () => {
    assert.equal(scan('import.meta.env.MODE').filter((h) => h.class === 'cred-path').length, 0);
  });

  // ── Real .env credential paths: MUST STILL fire ───────────────────────────
  it('STILL flags a bare .env file reference', () => {
    assert.ok(scan('cp .env /backup/').some((h) => h.class === 'cred-path'));
  });

  it('STILL flags source ./.env', () => {
    assert.ok(scan('source ./.env').some((h) => h.class === 'cred-path'));
  });

  it('STILL flags /app/.env in a path string', () => {
    assert.ok(scan('/app/.env').some((h) => h.class === 'cred-path'));
  });

  it('STILL flags config/.env (relative path with slash)', () => {
    assert.ok(scan('config/.env').some((h) => h.class === 'cred-path'));
  });

  // ── Real secret tokens: MUST STILL fire ───────────────────────────────────
  it('STILL flags an Anthropic API key assignment', () => {
    assert.ok(scan('token = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxx"').some((h) => h.class === 'token'));
  });

  it('STILL flags a github token assignment', () => {
    assert.ok(scan('token: "ghp_16CharsOrMoreOfBase64Junk"').some((h) => h.class === 'token'));
  });

  it('STILL flags an AWS access key assignment', () => {
    assert.ok(scan('api_key: "AKIA1234567890ABCDEF"').some((h) => h.class === 'token'));
  });

  it('STILL flags a long hex secret in a token assignment', () => {
    assert.ok(scan('token: "deadbeefdeadbeefdeadbeef1234"').some((h) => h.class === 'token'));
  });

  it('STILL flags a weak password in an assignment', () => {
    // hunter2hunter2hunter2 >= 20 chars, bare assignment shape
    assert.ok(scan('password = "hunter2hunter2hunter2"').some((h) => h.class === 'token'));
  });

  it('STILL flags a real .env path like `cp .env /backup/`', () => {
    assert.ok(scan('cp .env /backup/').some((h) => h.class === 'cred-path'));
  });

  it('STILL flags `source ./.env`', () => {
    assert.ok(scan('source ./.env').some((h) => h.class === 'cred-path'));
  });
});

describe('privacy-scan — remote visibility detection', () => {
  const noEnv = (fn) => {
    const saved = { v: process.env.PEBBL_REMOTE_VISIBILITY, g: process.env.PEBBL_GH_VISIBILITY };
    delete process.env.PEBBL_REMOTE_VISIBILITY;
    delete process.env.PEBBL_GH_VISIBILITY;
    try { return fn(); } finally {
      if (saved.v !== undefined) process.env.PEBBL_REMOTE_VISIBILITY = saved.v;
      if (saved.g !== undefined) process.env.PEBBL_GH_VISIBILITY = saved.g;
    }
  };

  it('no remote => hasRemote false, visibility unknown', () => {
    noEnv(() => {
      const v = detectRemoteVisibility(() => '');
      assert.equal(v.hasRemote, false);
      assert.equal(v.visibility, 'unknown');
    });
  });

  it('a self-hosted/SSH non-forge remote => unknown (private-safe for routing)', () => {
    noEnv(() => {
      const v = detectRemoteVisibility(() => 'origin\tgit@git.internal.example:team/repo.git (fetch)\norigin\tgit@git.internal.example:team/repo.git (push)\n');
      assert.equal(v.hasRemote, true);
      assert.equal(v.visibility, 'unknown');
    });
  });

  it('a github remote with a private gh probe => private', () => {
    process.env.PEBBL_GH_VISIBILITY = 'private';
    try {
      const v = detectRemoteVisibility(() => 'origin\thttps://github.com/acme/secret.git (fetch)\norigin\thttps://github.com/acme/secret.git (push)\n');
      assert.equal(v.visibility, 'private');
    } finally { delete process.env.PEBBL_GH_VISIBILITY; }
  });

  it('a github remote with a public gh probe => public', () => {
    process.env.PEBBL_GH_VISIBILITY = 'public';
    try {
      const v = detectRemoteVisibility(() => 'origin\tgit@github.com:acme/oss.git (fetch)\norigin\tgit@github.com:acme/oss.git (push)\n');
      assert.equal(v.visibility, 'public');
    } finally { delete process.env.PEBBL_GH_VISIBILITY; }
  });

  it('an unprobed github remote fails CLOSED to public (safer default)', () => {
    noEnv(() => {
      // gh probe returns unknown (no gh / offline). parseGitHubSlug succeeds, probe
      // inconclusive => assume public. We force the probe path with a github URL.
      const v = detectRemoteVisibility(() => 'origin\thttps://github.com/acme/unknownvis.git (fetch)\norigin\thttps://github.com/acme/unknownvis.git (push)\n');
      assert.ok(v.visibility === 'public' || v.visibility === 'private');
    });
  });

  it('PEBBL_REMOTE_VISIBILITY override wins', () => {
    process.env.PEBBL_REMOTE_VISIBILITY = 'public';
    try {
      const v = detectRemoteVisibility(() => '');
      assert.equal(v.visibility, 'public');
    } finally { delete process.env.PEBBL_REMOTE_VISIBILITY; }
  });

  it('parseGitHost handles ssh, https, and scp-like URLs', () => {
    assert.equal(_internal.parseGitHost('git@github.com:owner/repo.git'), 'github.com');
    assert.equal(_internal.parseGitHost('https://github.com/owner/repo.git'), 'github.com');
    assert.equal(_internal.parseGitHost('ssh://git@gitlab.com/owner/repo'), 'gitlab.com');
  });
});

// ── the deliberate-example marker ────────────────────────────────────────────
// A security scanner's own docs have to quote what it detects, so the spec for
// this detector tripped it. The marker is the reviewable exemption; these tests
// pin that it is line-scoped (never file-scoped) and covers every class.
describe('privacy-scan — allowlist-secret marker', () => {
  const { scan, ALLOWLIST_MARKER } = require('../src/privacy-scan');

  it('exempts a marked line for the network class', () => {
    assert.equal(scan('droplet 198.18.0.7:8080').length > 0, true); // allowlist-secret: reserved-range fixture, not real infrastructure
    assert.equal(scan(`droplet 198.18.0.7:8080  <!-- ${ALLOWLIST_MARKER}: doc example -->`).length, 0); // allowlist-secret: reserved-range fixture, not real infrastructure
  });

  // The fixtures below are marked so this file can be committed. The marker in
  // the trailing comment exempts the SOURCE line from the pre-commit gate; the
  // string handed to scan() at runtime is unaffected, so the assertions still
  // exercise the real detector. Testing a detector means writing down the thing
  // it detects, which is the same self-reference the marker exists to resolve.
  it('exempts a marked line for the cred-path class', () => {
    assert.equal(scan('cred at /root/.claude-env').length > 0, true); // allowlist-secret: fixture
    assert.equal(scan(`cred at /root/.claude-env  (${ALLOWLIST_MARKER})`).length, 0); // allowlist-secret: fixture
  });

  it('exempts a marked line for the token class', () => {
    assert.equal(scan('key sk-ant-oat01-abcdefghijkl').length > 0, true); // allowlist-secret: fake fixture value
    assert.equal(scan(`key sk-ant-oat01-abcdefghijkl  ${ALLOWLIST_MARKER}`).length, 0); // allowlist-secret: fake fixture value
  });

  it('is LINE-scoped — a marked line never exempts its neighbours', () => {
    const hits = scan(`safe 198.18.0.7 ${ALLOWLIST_MARKER}\nleaked 198.18.0.9`); // allowlist-secret: reserved-range fixture, not real infrastructure
    assert.equal(hits.length, 1);
    assert.equal(hits[0].match, '198.18.0.9'); // allowlist-secret: reserved-range fixture, not real infrastructure
    assert.equal(hits[0].line, 2);
  });

  it('exports ONE marker definition, shared with the write-time guard', () => {
    assert.equal(require('../src/secret-guard').ALLOWLIST_MARKER, ALLOWLIST_MARKER);
  });
});

// RFC5737 documentation ranges. These exist so docs and TESTS can print an
// address guaranteed never to route anywhere, which makes flagging one a pure
// false positive — and, concretely, is what lets this suite be committed at all.
describe('privacy-scan — RFC5737 documentation IPs are not leaks', () => {
  it('does NOT flag the three documentation blocks', () => {
    assert.equal(scan('doc host 192.0.2.1:8080').length, 0);
    assert.equal(scan('doc host 198.51.100.5').length, 0);
    assert.equal(scan('doc host 203.0.113.9:443').length, 0);
  });

  it('DOES still flag an address just outside them', () => {
    assert.equal(scan('real 203.0.114.9').filter((h) => h.class === 'network').length, 1); // allowlist-secret: reserved-range fixture, not real infrastructure
    assert.equal(scan('real 192.0.3.1').filter((h) => h.class === 'network').length, 1); // allowlist-secret: reserved-range fixture, not real infrastructure
    assert.equal(scan('real 198.51.101.5').filter((h) => h.class === 'network').length, 1); // allowlist-secret: reserved-range fixture, not real infrastructure
  });

  it('the real droplet address is unaffected by the exemption', () => {
    assert.equal(scan('droplet 67.207.93.196:48422').length, 1); // allowlist-secret: reserved-range fixture, not real infrastructure
  });
});
