'use strict';
// P5 — the shared, pure secret/PII detector. ONE leak-class definition reused
// by BOTH the git hooks (pre-commit / pre-push, forward gate) and
// `pebbl audit-history` (the one-time backward scan over committed history).
// DRY: there is exactly one place that decides "this line leaks," so the
// forward and historical scans can never disagree.
//
// The design's killer risk is that append-only memory can NEVER forget: a
// secret committed once lives in every clone/fork forever and can only be
// hidden from the live view, never deleted. So the scan must catch the three
// classes the LIVE sw-factory store actually leaks (design Privacy, lines
// 40-44) — a token-shape regex ALONE is insufficient (it misses IPs and
// credential paths, and false-negatives on a rotated-shape token):
//
//   (a) NETWORK: a non-RFC1918 IPv4 address, and any host:port pair on a
//       public IP. RFC1918 private ranges (10/8, 172.16/12, 192.168/16) plus
//       loopback/link-local are explicitly NOT leaks — they're local infra.
//   (b) CREDENTIAL FILE PATHS: `.env`, `.claude-env`, `/etc/*-bot.env`, and
//       the design's named paths (/root/.claude-env, the four bot.env paths).
//   (c) PII / NAME DENYLIST: real names seeded from the repo's anon name-map
//       (the `real` strings — what must never leak). Loaded from a configurable
//       source; degrades GRACEFULLY to an empty denylist if no map exists, so a
//       repo without a name-map still gets classes (a) and (b) and never crashes.
//
// Plus a TOKEN-SHAPE class for high-confidence secret shapes (sk-ant-…,
// AWS keys, github tokens, long hex/base64 blobs in an assignment) — additive
// to, not a replacement for, the three classes above.
//
// This module is PURE + side-effect free in its core (scan/_internal), modeled
// on src/scan-commits.js: a pure matching core, a CLI shell that NEVER
// auto-acts (it only reports + sets a non-zero exit), and an `_internal` export
// for tests. The hooks shell into this; the detector itself touches no git.

const fs = require('fs');
const path = require('path');

// ── (a) network ───────────────────────────────────────────────────────────────
// Match a dotted IPv4. We validate octet ranges so "version 1.2.3 build 4" only
// matches a real 4-octet address, and classify RFC1918 / loopback / link-local
// as PRIVATE (not a leak).
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

function isValidOctet(n) {
  return n >= 0 && n <= 255;
}

// RFC5737 documentation ranges: addresses reserved so that docs, examples, and
// TESTS can print an IP that is guaranteed never to route anywhere real. An
// address from these blocks cannot BE infrastructure, so flagging one is a pure
// false positive — the same reasoning that exempts RFC1918, arrived at from the
// other direction (private = not reachable from outside; documentation = not
// reachable at all).
//
// This matters more than it looks: without it, this scanner's own test suite
// cannot be committed, because a test for "detects a public host:port" has to
// contain a public host:port. A tool whose tests trip its own gate ends up with
// the gate disabled, not with better tests.
function isDocumentationIp(a, b, c) {
  if (a === 192 && b === 0 && c === 2) return true;           // 192.0.2.0/24   TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true;        // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;         // 203.0.113.0/24 TEST-NET-3
  return false;
}

// RFC1918 + loopback + link-local + "this host" — local infra, never a leak.
function isPrivateIp(a, b, c, d) {
  if (a === 10) return true;                                  // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                    // 192.168.0.0/16
  if (a === 127) return true;                                 // loopback
  if (a === 169 && b === 254) return true;                    // link-local
  if (a === 0) return true;                                   // 0.0.0.0/8 "this host"
  if (isDocumentationIp(a, b, c)) return true;                // RFC5737 — see above
  void d;
  return false;
}

// Find every non-private IPv4 in the text, with an optional :port suffix.
// Returns [{ ip, port, index }].
function findPublicIps(text) {
  const out = [];
  let m;
  IPV4_RE.lastIndex = 0;
  while ((m = IPV4_RE.exec(text)) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    const d = Number(m[4]);
    if (![a, b, c, d].every(isValidOctet)) continue; // not a real IPv4
    if (isPrivateIp(a, b, c, d)) continue;           // RFC1918 / loopback — fine
    // optional :port immediately after the address
    const after = text.slice(m.index + m[0].length);
    const portMatch = /^:(\d{1,5})\b/.exec(after);
    const port = portMatch ? Number(portMatch[1]) : null;
    out.push({ ip: m[0], port, index: m.index });
  }
  return out;
}

// ── (b) credential file paths ────────────────────────────────────────────────
// Literal credential-bearing paths the live store leaks. We match the design's
// named paths explicitly AND the general shapes (*.env basenames, dot-env files,
// /etc/*-bot.env), so a NEW bot.env path is still caught without a code change.
const CRED_PATH_PATTERNS = [
  // dot-env style basenames: .env, .env.local, .claude-env, .factory-env, etc.
  /(^|[\s"'`(=:/\\])\.(?:[a-z0-9-]+-)?env(?:\.[a-z0-9.-]+)?\b/i,
  // any *-bot.env or *.env file under a path (e.g. /etc/factory-updates-bot.env).
  // Requires a slash OR a hyphen somewhere in the matched token so that
  // JS property accesses like `process.env` and `import.meta.env` are not
  // flagged — those contain only word chars and dots, never a path separator
  // or hyphen. Real dotfile paths (/app/.env, config/.env) and hyphenated
  // filenames (factory-updates-bot.env) still fire.
  /(?:[\w/-]*-[\w/-]*|[\w.]*\/[\w./-]*)\.env\b/i,
  // explicit /etc|/root credential dirs naming env/secret/token/credential files
  /\/(?:etc|root|home\/[^/\s]+)\/[\w./-]*(?:bot\.env|\.env|\.claude-env|secret|credential|token)[\w./-]*/i,
];

function findCredPaths(text) {
  const raw = [];
  for (const re of CRED_PATH_PATTERNS) {
    const m = re.exec(text);
    if (m) raw.push({ match: m[0].trim(), index: m.index });
  }
  // Several patterns intentionally overlap (a .env basename also matches the
  // generic *.env shape). Keep the LONGEST (most specific) match and drop any
  // whose text is already contained in a kept match, so one path reports once.
  raw.sort((a, b) => b.match.length - a.match.length);
  const kept = [];
  for (const h of raw) {
    const cleaned = h.match.replace(/^[\s"'`(=:]+/, '');
    if (!cleaned) continue;
    if (kept.some((k) => k.match.includes(cleaned))) continue;
    kept.push({ match: cleaned, index: h.index });
  }
  return kept;
}

// ── token shapes (additive high-confidence secret shapes) ────────────────────
// The `assignment` shape MUST stay shape-compatible with the factory promote
// gate's SECRET_RE (sw-factory/droplet/promote-main.sh, the `(password|secret|
// api[_-]?key|token)[:=]value` alternatives). That gate blocks a staging->main
// promote when a committed .md quotes one of these, even a known-fake fixture
// value; the redact() projection filter below uses THIS pattern to mask the
// value at render time so committed pebbl memory stops tripping it. Keep the
// keyword list + length thresholds (>=20 unquoted, >=12 quoted) in sync with
// SECRET_RE — if the gate's keywords change, change them here too, in lockstep,
// so the forward gate and the projection mask never disagree (DRY: one shape).
// The value is captured in group 1 (or group 2 for the quoted form) so redact()
// can mask only the value and keep the `key=` prefix readable.
const ASSIGNMENT_KEYWORDS = 'password|secret|api[_-]?key|token|passwd|access[_-]?token';
const TOKEN_PATTERNS = [
  { name: 'anthropic-oauth', re: /\bsk-ant-[a-z0-9-]{8,}/i },
  { name: 'anthropic-api', re: /\bsk-ant-api[0-9]{2}-[a-z0-9_-]{8,}/i },
  { name: 'openai', re: /\bsk-[a-zA-Z0-9]{20,}/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  // assignment shape, gate-compatible. Quoted form first (the value can hold
  // spaces/specials inside the quotes); group 1 is the quoted value, group 2 the
  // bare value. Mirrors SECRET_RE's two assignment alternatives.
  { name: 'assignment-quoted', re: new RegExp(`(?:${ASSIGNMENT_KEYWORDS})["']?\\s*[:=]\\s*["']([^"']{12,})["']`, 'i'), valueGroup: 1 },
  { name: 'assignment-bare', re: new RegExp(`(?:${ASSIGNMENT_KEYWORDS})\\s*[:=]\\s*([A-Za-z0-9+/_=-]{20,})`, 'i'), valueGroup: 1 },
];

// W3C DTCG design-token paths (e.g. "color.primary", "typography.size.sm"):
// only lowercase letters, digits, and dots. Real secrets never look like this
// (they're hex, base64, UUIDs, bearer strings). Skip assignment-quoted/bare hits
// whose captured VALUE is purely a dot-notation identifier so that
//   { "token": "color.primary" }
// in design-system schema files doesn't trip the scanner. Structural exemption
// only — the dot-notation shape is too narrow to be a real secret.
const DTCG_TOKEN_PATH_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

function findTokens(text) {
  const out = [];
  for (const { name, re, valueGroup } of TOKEN_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    // Skip assignment-shape hits whose captured value is a W3C DTCG token path
    // (dot-notation identifier like "color.primary" or "typography.size.sm").
    // Real credentials are hex, base64, UUIDs, or bearer strings — never
    // all-lowercase dot-separated identifiers.
    if (valueGroup != null && m[valueGroup] != null &&
        DTCG_TOKEN_PATH_RE.test(m[valueGroup].trim())) {
      continue;
    }
    const hit = { shape: name, match: m[0], index: m.index };
    // For the assignment shapes, record the absolute span of just the VALUE
    // (the captured group) so redact() can mask the secret while keeping the
    // `key=` prefix. The whole-match shapes (token formats) have no group; they
    // are masked entirely.
    if (valueGroup && m[valueGroup] != null) {
      const valueStart = m.index + m[0].indexOf(m[valueGroup]);
      hit.valueStart = valueStart;
      hit.valueEnd = valueStart + m[valueGroup].length;
    }
    out.push(hit);
  }
  return out;
}

// ── projection redaction (the db -> .md render boundary) ─────────────────────
// REDACTED is the placeholder the projection writes in place of a secret SHAPE.
// It is chosen so it can NEVER itself re-trip a scan: it has no `=`/`:` after a
// keyword, no 20-char run, and matches none of the token formats — so a
// re-projection of an already-masked file stays masked (idempotent) and the
// promote gate sees nothing secret-shaped. Do not change it to something that
// embeds an `=value` or a long alnum run.
const REDACTED = '<redacted>';

// Mask every TOKEN-class secret shape in `text` (the same shapes findTokens
// detects, which include the gate-compatible `key=value` assignment) and return
// the sanitized string. ONLY the token class is masked — this is the leak class
// the factory promote gate blocks on, and it's the class with no legitimate
// place in a human-readable memory projection. Network IPs, cred paths and
// denylisted names are deliberately NOT touched here: those are handled by the
// pre-commit/pre-push gate + audit-history (an IP/path is often load-bearing
// context an author wrote on purpose), and silently rewriting them would change
// the meaning of committed memory. This filter exists so a quoted FAKE fixture
// key in a note can't false-block a promote.
//
// Determinism: the same input always yields the same output (pure string op, no
// clock/random), so re-projecting the same DB rows produces byte-identical .md
// (Acceptance #4). Applied PER LINE so a hit's index/value-span stays valid, and
// looped until a line is clean so multiple secrets on one line are all masked.
function redact(text) {
  if (text == null) return text;
  const str = String(text);
  if (str.indexOf('\n') === -1) return redactLine(str);
  return str.split('\n').map(redactLine).join('\n');
}

function redactLine(line) {
  let out = line;
  // findTokens reports at most one hit per pattern and several patterns can
  // match overlapping spans, so mask exactly ONE hit per pass (the right-most,
  // so any other hit's index stays valid is moot — we re-scan anyway) and loop.
  // REDACTED never re-matches a token shape, so each pass removes at least one
  // shape and this terminates well before the guard. The guard only caps a
  // pathological input.
  for (let guard = 0; guard < 256; guard++) {
    const hits = findTokens(out);
    if (hits.length === 0) break;
    // Pick the hit nearest the end of the line so masking can't invalidate an
    // earlier-starting overlapping hit before we get to it on the next pass.
    let h = hits[0];
    for (const c of hits) if (c.index > h.index) h = c;
    if (h.valueStart != null && h.valueEnd != null) {
      // assignment shape: mask only the VALUE, keep `key=` readable.
      out = out.slice(0, h.valueStart) + REDACTED + out.slice(h.valueEnd);
    } else {
      // whole-match token shape (sk-…, AKIA…, gh*_…): mask the entire token.
      out = out.slice(0, h.index) + REDACTED + out.slice(h.index + h.match.length);
    }
  }
  return out;
}

// ── (c) PII / name denylist ──────────────────────────────────────────────────
// The denylist is the set of REAL strings from an anon name-map (the values
// that must never leak). The map is the same `[{real, pseudonym, type}]` shape
// the factory's anonymize tool emits. Resolution order (configurable source):
//   1. explicit opts.denylist (array of strings) — used by tests
//   2. explicit opts.nameMapPath
//   3. $PEBBL_NAME_MAP env var
//   4. <pebblDir>/name-map.json  (opts.pebblDir)
//   5. <repoRoot>/name-map.json  (opts.repoRoot)
// Missing / unreadable / malformed map => empty denylist (degrade gracefully,
// never throw). Only `real` strings longer than 2 chars are denylisted, so a
// one-letter pseudonym key can't carpet-match the whole corpus.
function loadDenylist(opts = {}) {
  if (Array.isArray(opts.denylist)) {
    return opts.denylist.filter((s) => typeof s === 'string' && s.trim().length > 2);
  }
  const candidates = [];
  if (opts.nameMapPath) candidates.push(opts.nameMapPath);
  if (process.env.PEBBL_NAME_MAP) candidates.push(process.env.PEBBL_NAME_MAP);
  if (opts.pebblDir) candidates.push(path.join(opts.pebblDir, 'name-map.json'));
  if (opts.repoRoot) candidates.push(path.join(opts.repoRoot, 'name-map.json'));

  for (const p of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      const names = [];
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          if (e && typeof e.real === 'string') names.push(e.real);
        }
      } else if (parsed && typeof parsed === 'object') {
        // also accept a {real: pseudonym} flat map
        for (const k of Object.keys(parsed)) names.push(k);
      }
      const filtered = names.filter((s) => typeof s === 'string' && s.trim().length > 2);
      if (filtered.length) return filtered;
    } catch {
      // malformed / unreadable map — try the next candidate, never crash
    }
  }
  return [];
}

// Escape a denylist entry for use inside a regex (names can contain ., (, ) …).
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findNames(text, denylist) {
  if (!denylist || denylist.length === 0) return [];
  const out = [];
  for (const name of denylist) {
    // Word-ish boundary so "Kingdom" matches "Kingdom" but the surrounding
    // pseudonym substitution isn't required to be standalone; we use a
    // case-insensitive substring with boundaries that tolerate punctuation.
    const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(name)}([^A-Za-z0-9]|$)`, 'i');
    const m = re.exec(text);
    if (m) out.push({ name, index: m.index });
  }
  return out;
}

// ── the deliberate-example marker ────────────────────────────────────────────
// A line carrying this marker is exempt from EVERY leak class.
//
// It exists because a security scanner's own documentation has to quote the
// things it detects, so the doc that specifies this detector trips it — the
// fake weapon airport screeners slide through the X-ray to check the operator
// is awake, flagged as a real one. Without an exemption the only fixes are to
// weaken the patterns (losing real detections) or to skip the gate (losing the
// gate). A marker keeps both.
//
// The marker is deliberately a plain, greppable string rather than a clever
// syntax: `git grep allowlist-secret` enumerates every exemption in the repo in
// one command, which is the property that makes an exemption reviewable. It is
// scoped to the LINE, never the file, so it can't quietly widen over time.
//
// This is the single definition — src/secret-guard.js imports it from here so
// the store-write guard and the git-hook detector can never disagree about what
// an exemption looks like.
const ALLOWLIST_MARKER = 'allowlist-secret';

// ── the core: scan one chunk of text ─────────────────────────────────────────
// Returns an array of hits: { class, match, line, index }. `class` is one of
// 'network' | 'cred-path' | 'token' | 'name'. Empty array => clean.
// Pure: no I/O beyond the denylist load the CALLER passes in (we resolve the
// denylist once via opts so a multi-line scan doesn't re-read the map per line).
function scan(text, opts = {}) {
  if (text == null) return [];
  const denylist = Array.isArray(opts._denylist) ? opts._denylist : loadDenylist(opts);
  const hits = [];
  const str = String(text);
  const lines = str.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    // A marked line is a deliberate example (see ALLOWLIST_MARKER). Skip it
    // before any detector runs, so the exemption covers every class uniformly
    // rather than whichever ones someone remembered to wire it into.
    if (line.includes(ALLOWLIST_MARKER)) continue;
    for (const ip of findPublicIps(line)) {
      hits.push({
        class: 'network',
        match: ip.port != null ? `${ip.ip}:${ip.port}` : ip.ip,
        detail: ip.port != null ? 'public host:port' : 'public IP',
        line: lineNo,
        index: ip.index,
      });
    }
    for (const c of findCredPaths(line)) {
      hits.push({ class: 'cred-path', match: c.match, detail: 'credential file path', line: lineNo, index: c.index });
    }
    for (const t of findTokens(line)) {
      hits.push({ class: 'token', match: t.match, detail: `token shape: ${t.shape}`, line: lineNo, index: t.index });
    }
    for (const n of findNames(line, denylist)) {
      hits.push({ class: 'name', match: n.name, detail: 'PII / denylisted name', line: lineNo, index: n.index });
    }
  }
  return hits;
}

// Scan many (path, text) pairs, resolving the denylist ONCE. Returns
// [{ file, hits: [...] }] for files with at least one hit.
function scanFiles(files, opts = {}) {
  const denylist = loadDenylist(opts);
  const out = [];
  for (const f of files) {
    const hits = scan(f.text, { ...opts, _denylist: denylist });
    if (hits.length) out.push({ file: f.path, hits });
  }
  return out;
}

// ── remote visibility detection (shared by the pre-push gate AND log.js's
// foundation private-by-default routing) ─────────────────────────────────────
// Returns { hasRemote, visibility: 'public'|'private'|'unknown', remotes, reason }.
// We can't always KNOW (no remote, an SSH host we can't probe, a self-hosted
// git). The honest contract: only a remote we can positively identify as a
// PUBLIC host (github.com/gitlab.com/bitbucket over https with a reachable
// public-API yes, or an explicit override) is treated as public. Everything
// else is treated as PRIVATE-OR-UNKNOWN, which is the SAFE default for
// foundation routing (private repos share foundation freely) — BUT the public
// push GATE must fail-safe the other way (see auditCleanForPush). A
// PEBBL_REMOTE_VISIBILITY env override exists for tests / self-hosted setups.
function detectRemoteVisibility(execGit) {
  // execGit(args[]) -> string (stdout) or throws. Injected so this stays
  // testable without spawning git. Callers pass a thin execFileSync wrapper.
  let remotesRaw = '';
  try {
    remotesRaw = execGit(['remote', '-v']) || '';
  } catch {
    remotesRaw = '';
  }
  const remotes = [];
  for (const line of remotesRaw.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(line.trim());
    if (m && m[3] === 'fetch') remotes.push({ name: m[1], url: m[2] });
  }

  const override = process.env.PEBBL_REMOTE_VISIBILITY;
  if (override === 'public' || override === 'private') {
    return { hasRemote: remotes.length > 0, visibility: override, remotes, reason: 'env override' };
  }

  if (remotes.length === 0) {
    return { hasRemote: false, visibility: 'unknown', remotes, reason: 'no remote configured' };
  }

  // Classify each remote URL. A KNOWN public host (github/gitlab/bitbucket)
  // we can probe; a private/SSH/self-hosted URL we treat as private-or-unknown.
  let sawPublicHost = false;
  for (const r of remotes) {
    const host = parseGitHost(r.url);
    if (host && PUBLIC_GIT_HOSTS.has(host)) sawPublicHost = true;
  }

  if (!sawPublicHost) {
    // self-hosted / unknown host: can't prove public → treat as private for
    // foundation routing, but the PUSH gate stays conservative separately.
    return { hasRemote: true, visibility: 'unknown', remotes, reason: 'remote host not a known public forge' };
  }

  // A known public forge. Probe the repo's visibility via the host API when we
  // can resolve owner/repo; if the probe is inconclusive we FAIL CLOSED to
  // 'public' (the safer assumption — a public repo treated as private would
  // leak foundation entries; treating private as public only adds friction).
  for (const r of remotes) {
    const slug = parseGitHubSlug(r.url);
    if (slug) {
      const vis = probeGitHubVisibility(slug, execGit);
      if (vis === 'public' || vis === 'private') {
        return { hasRemote: true, visibility: vis, remotes, reason: `probed ${slug.host}` };
      }
    }
  }
  // Known public forge but couldn't probe → assume public (fail closed/safe).
  return { hasRemote: true, visibility: 'public', remotes, reason: 'public forge, visibility unprobed (assumed public)' };
}

const PUBLIC_GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

function parseGitHost(url) {
  if (!url) return null;
  // git@github.com:owner/repo.git
  let m = /^[\w.-]+@([\w.-]+):/.exec(url);
  if (m) return m[1].toLowerCase();
  // https://github.com/owner/repo.git  |  ssh://git@github.com/owner/repo
  m = /^[a-z]+:\/\/(?:[^@/]+@)?([\w.-]+)(?:[:/])/.exec(url);
  if (m) return m[1].toLowerCase();
  return null;
}

function parseGitHubSlug(url) {
  const host = parseGitHost(url);
  if (host !== 'github.com') return null;
  // owner/repo from either ssh or https form, strip trailing .git
  let m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (!m) return null;
  return { host, owner: m[1], repo: m[2] };
}

// Best-effort GitHub visibility probe. Uses `gh` if present (authenticated),
// else falls back to an unauthenticated API request via the host's curl. Any
// failure returns 'unknown' so the caller can apply its fail-safe default. We
// route through execGit's sibling exec by accepting an optional probe override
// for tests.
function probeGitHubVisibility(slug, execGit) {
  void execGit;
  // Test / offline override: PEBBL_GH_VISIBILITY=public|private short-circuits.
  const o = process.env.PEBBL_GH_VISIBILITY;
  if (o === 'public' || o === 'private') return o;

  const { execFileSync } = require('child_process');
  const ask = (env) => {
    try {
      const out = execFileSync('gh', ['repo', 'view', `${slug.owner}/${slug.repo}`, '--json', 'visibility', '-q', '.visibility'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        env: env ? { ...process.env, ...env } : process.env,
      }).trim().toLowerCase();
      if (out === 'public') return 'public';
      if (out === 'private' || out === 'internal') return 'private';
    } catch {
      // gh missing / unauthenticated / no access / network — caller decides
    }
    return 'unknown';
  };

  const active = ask(null);
  if (active !== 'unknown') return active;

  // The ACTIVE gh account may simply have no grant on this repo — GitHub answers
  // 404 rather than 403 for a repo a token cannot see, which is indistinguishable
  // from "does not exist". Left there, a PRIVATE repo reads as unprobed, the
  // caller fails closed to 'public', and the strictest gate fires on a repo that
  // was never published. That is not a safe default so much as a wrong answer
  // wearing one.
  //
  // So ask the OTHER authenticated accounts too. The question is "can any
  // credential I hold see this repo, and what does it say" — a repo one of your
  // own accounts reads as private IS private. Only runs on the unknown path, so
  // the common case still costs a single probe.
  try {
    const status = execFileSync('gh', ['auth', 'status'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    const users = Array.from(status.matchAll(/Logged in to \S+ account (\S+)/g)).map((m) => m[1]);
    for (const u of users) {
      let token = '';
      try {
        token = execFileSync('gh', ['auth', 'token', '--user', u], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
        }).trim();
      } catch { continue; }
      if (!token) continue;
      const v = ask({ GH_TOKEN: token });
      if (v !== 'unknown') return v;
    }
  } catch {
    // no gh / cannot enumerate accounts — fall through to unknown
  }
  return 'unknown';
}

// ── the CLI shell the git hooks shell into ───────────────────────────────────
// `pebbl privacy-scan --staged`  (pre-commit): scan the ADDED lines of the
//   staged diff. A hit => print the findings, exit 1, refuse the commit.
// `pebbl privacy-scan --push`    (pre-push): scan the commits being pushed AND,
//   on a PUBLIC remote, enforce the hard gate — a clean FULL-history *.md scan
//   must pass before a shared push is allowed. A hit => exit 1.
// Default (no flag): read stdin and scan it (composable / testable).
//
// This shell NEVER edits, stages, or mutates anything. It only reports + sets a
// non-zero exit, exactly like scan-commits never auto-logs. Best-effort: if git
// plumbing is unavailable it errs on the side of ALLOWING the commit (exit 0)
// rather than wedging the user's workflow on a tooling gap — the gate is a
// guardrail, not a tripwire (a false block on every commit would get the hook
// deleted, which is worse than a missed scan; audit-history is the backstop).

function execGitRaw(repoRoot, args) {
  const { execFileSync } = require('child_process');
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

// Added lines of the staged diff, grouped BY FILE.
//
// Per-file rather than one concatenated blob for two reasons: the block message
// can name the file, and — the reason this exists — the accept ledger has to be
// exempt. The ledger's whole job is to record the matched strings an operator
// has reviewed, so scanning it re-flags every accept and the file can never be
// committed. Same self-reference as the scanner's own spec doc, but a JSON file
// can't carry a line marker, so the exemption is by exact path.
//
// The exemption is deliberately ONE fixed filename at the repo root, not a
// pattern: a leak can't be smuggled past the gate by naming a file cleverly,
// and `audit-ledger.js` refuses to write a token-class value into it in the
// first place, so the one file this skips can never hold a live secret shape.
function stagedAddedByFile(repoRoot) {
  const diff = execGitRaw(repoRoot, ['diff', '--cached', '--unified=0', '--no-color']);
  const files = [];
  let current = null;
  let nextLineNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      // '+++ b/path/to/file' — or '+++ /dev/null' for a deletion.
      const p = line.slice(4).replace(/^b\//, '').trim();
      current = p === '/dev/null' ? null : { path: p, added: new Map() };
      if (current) files.push(current);
      continue;
    }
    if (line.startsWith('@@')) {
      // '@@ -old,n +new,m @@' — `new` is where this hunk's added lines land in
      // the post-commit file. Tracked so a reported line number is the line the
      // author can actually jump to; without it the numbers are positions in a
      // synthetic added-lines blob, which sends you to the wrong place in a
      // long diff and quietly erodes trust in the whole message.
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      if (m) nextLineNo = Number(m[1]);
      continue;
    }
    if (line.startsWith('+') && current) {
      current.added.set(nextLineNo, line.slice(1));
      nextLineNo += 1;
    }
  }
  const { LEDGER_FILENAME } = require('./audit-ledger');
  return files
    .filter((f) => f.path !== LEDGER_FILENAME)
    .map((f) => ({ path: f.path, lines: f.added }));
}

// Scan one staged file's added lines, reporting each hit at its REAL line
// number in the post-commit file rather than at an offset into a synthetic blob.
function scanStagedFile(file, opts) {
  const hits = [];
  for (const [lineNo, text] of file.lines) {
    for (const h of scan(text, opts)) hits.push({ ...h, line: lineNo });
  }
  return hits;
}

function repoRootOf(startDir) {
  const root = execGitRaw(startDir || process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  return root || (startDir || process.cwd());
}

function printHits(label, hits) {
  console.error(`\npebbl privacy-scan: BLOCKED — ${hits.length} potential leak${hits.length === 1 ? '' : 's'} in ${label}:`);
  for (const h of hits) {
    console.error(`  [${h.class}] ${h.match}  (${h.detail}, line ${h.line})`);
  }
  console.error('\nThis content would be committed/pushed into shared, append-only memory, where it');
  console.error('cannot ever be un-leaked. Remove the secret/PII (or move it to events.local.jsonl),');
  console.error('then retry. RFC1918 IPs and pseudonyms are fine. (To inspect: pebbl audit-history.)');
}

// Full-history *.md scan for the public-repo hard gate. Reuses audit-history's
// blob walk so "clean" means the same thing forward and backward. Returns hits[].
function fullHistoryMdHits(repoRoot, opts) {
  try {
    const { _internal } = require('./audit-history');
    const pairs = _internal.collectMdBlobs(repoRoot);
    return _internal.auditBlobs(
      pairs,
      (commit, p) => _internal.showBlob(repoRoot, commit, p),
      opts,
    );
  } catch {
    return [];
  }
}

function cli(args) {
  const argv = Array.isArray(args) ? args : [];
  const repoRoot = repoRootOf(process.cwd());
  const findPebbl = (() => {
    try { return require('./find-pebbl').findPebblDir(); } catch { return null; }
  })();
  const opts = { repoRoot, pebblDir: findPebbl || undefined };

  // pre-push: scan the push AND enforce the public-repo hard gate.
  if (argv.includes('--push')) {
    const vis = detectRemoteVisibility((a) => execGitRaw(repoRoot, a));
    // Always scan the staged-equivalent: on push there's nothing staged, so
    // scan the working-tree *.md plus the full history when public.
    if (vis.visibility === 'public') {
      const hits = fullHistoryMdHits(repoRoot, opts);
      // Subtract the operator's recorded ACCEPT decisions. Without this the gate
      // deadlocks: a finding in an ALREADY-PUSHED commit can never be cleaned
      // without rewriting published history, so the gate would block every
      // future push forever and train the operator to always set
      // PEBBL_SKIP_SCAN — disarming it for the day a real leak appears. The
      // ledger fails closed, so an unreadable one accepts nothing.
      const { loadLedger, partition } = require('./audit-ledger');
      const ledger = loadLedger(repoRoot);
      if (ledger.error) {
        console.error(`\npebbl privacy-scan: the accept ledger at ${ledger.path} is unreadable (${ledger.error}).`);
        console.error('Failing closed — every finding counts as unaccepted until it is fixed.');
      }
      const { blocking, accepted } = partition(hits, ledger.accepted);
      if (blocking.length) {
        printHits('committed .md history (public remote — hard gate)', blocking.slice(0, 50));
        console.error(`\nThis remote is PUBLIC (${vis.reason}). A shared push is blocked until every`);
        console.error('finding above is either ROTATED at its source or explicitly ACCEPTED:');
        console.error('  pebbl audit-history                       review the full list');
        console.error('  pebbl audit-history --accept <id> --reason "..."   record a decision');
        if (accepted.length) {
          console.error(`\n(${accepted.length} previously accepted finding${accepted.length === 1 ? '' : 's'} did not block this push.)`);
        }
        process.exit(1);
      }
    }
    process.exit(0);
  }

  // pre-commit (--staged): scan each staged file's added lines separately, so a
  // hit can name its file and the accept ledger can be exempted by path.
  if (argv.includes('--staged')) {
    const denylist = loadDenylist(opts);
    const scanOpts = { ...opts, _denylist: denylist };
    const flat = [];
    for (const f of stagedAddedByFile(repoRoot)) {
      for (const h of scanStagedFile(f, scanOpts)) {
        flat.push({ ...h, file: f.path, detail: `${h.detail} in ${f.path}` });
      }
    }

    // The staged gate goes through the SAME accept ledger as the push gate.
    //
    // Without this it has no accept path at all, and that is worse here than it
    // was for history: a machine-written store file (`.pebbl/events.jsonl`) can
    // legitimately RECORD a credential path — "loom reads secrets from
    // ~/.config/loom/secrets.env" is a fact worth remembering, not a leak — and (allowlist-secret: illustrative path in a comment)
    // an append-only log cannot be hand-edited to carry a line marker. So the
    // only escape was PEBBL_SKIP_SCAN, which disables the whole scan for the
    // whole commit. One ledger, two producers of findings.
    const { loadLedger, saveLedger, partition, groupByFingerprint, toEntry, resolveId } = require('./audit-ledger');
    const ledger = loadLedger(repoRoot);
    if (ledger.error) {
      console.error(`\npebbl privacy-scan: the accept ledger at ${ledger.path} is unreadable (${ledger.error}).`);
      console.error('Failing closed — every finding counts as unaccepted until it is fixed.');
    }
    const { blocking } = partition(flat, ledger.accepted);

    const acceptIdx = argv.findIndex((a) => a === '--accept' || a.startsWith('--accept='));
    if (acceptIdx !== -1) {
      if (ledger.error) {
        console.error('pebbl privacy-scan: refusing to edit an unreadable ledger.');
        process.exit(1);
      }
      const inline = argv[acceptIdx].startsWith('--accept=') ? argv[acceptIdx].slice('--accept='.length) : null;
      const target = inline || argv[acceptIdx + 1];
      const rIdx = argv.findIndex((a) => a === '--reason' || a.startsWith('--reason='));
      const reasonRaw = rIdx === -1
        ? ''
        : (argv[rIdx].startsWith('--reason=') ? argv[rIdx].slice('--reason='.length) : argv[rIdx + 1]);
      const reason = (reasonRaw || '').trim();
      if (!target) {
        console.error('Usage: pebbl privacy-scan --staged --accept <id|all> --reason "..."');
        process.exit(1);
      }
      if (!reason) {
        console.error('pebbl privacy-scan: --accept requires --reason "why this is safe to accept".');
        console.error('An accept is a security decision that outlives the session; an unexplained');
        console.error('one is PEBBL_SKIP_SCAN with extra steps.');
        process.exit(1);
      }
      const groups = groupByFingerprint(blocking);
      if (groups.length === 0) {
        console.log('pebbl privacy-scan: nothing to accept — no unaccepted findings staged.');
        process.exit(0);
      }
      let targets;
      if (target === 'all') {
        targets = groups;
      } else {
        const { id, error } = resolveId(target, groups.map((g) => g.id));
        if (error) { console.error(`pebbl privacy-scan: ${error}`); process.exit(1); }
        targets = [groups.find((g) => g.id === id)];
      }
      const now = new Date().toISOString();
      for (const g of targets) {
        ledger.accepted.set(g.id, toEntry(g, reason, now));
        console.log(`accepted ${g.id}  [${g.class}]  ${g.class === 'token' ? '(value withheld)' : g.match}  in ${g.file}`);
      }
      saveLedger(repoRoot, ledger.accepted);
      console.log(`\nLedger written: ${ledger.path}  (stage and commit it alongside.)`);
      process.exit(0);
    }

    if (blocking.length) {
      printHits('the staged diff', blocking);
      console.error('\nIf a finding is a deliberate, non-secret fact (a credential PATH is not a');
      console.error('credential), record the decision instead of skipping the scan:');
      console.error('  pebbl privacy-scan --staged --accept all --reason "..."');
      console.error('For a hand-written line, `allowlist-secret` on that line is the narrower fix.');
      process.exit(1);
    }
    process.exit(0);
  }

  // stdin (default) — composable / testable.
  let text = '';
  try { text = require('fs').readFileSync(0, 'utf8'); } catch { text = ''; }
  const hits = scan(text, opts);
  if (hits.length) {
    printHits('input', hits);
    process.exit(1);
  }
  process.exit(0);
}

module.exports = {
  scan,
  scanFiles,
  redact,
  REDACTED,
  ALLOWLIST_MARKER,
  cli,
  loadDenylist,
  detectRemoteVisibility,
  // legacy/alt names the verify harness probes for
  scanText: scan,
  _internal: {
    scan,
    redact,
    redactLine,
    REDACTED,
    findPublicIps,
    findCredPaths,
    findTokens,
    findNames,
    isPrivateIp,
    isDocumentationIp,
    loadDenylist,
    detectRemoteVisibility,
    parseGitHost,
    parseGitHubSlug,
    PUBLIC_GIT_HOSTS,
    TOKEN_PATTERNS,
    CRED_PATH_PATTERNS,
  },
};
