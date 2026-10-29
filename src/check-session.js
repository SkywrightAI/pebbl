'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findPebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { loadConfig } = require('./rubric');

// `pebbl check-session` — the Claude Code Stop hook init installs.
//
// Holds a turn ONCE when its work isn't in pebbl:
//   1. Unlogged change: the newest local change (a commit made since the session
//      started, or a dirty file modified since then, outside .pebbl/) is newer
//      than the newest pebbl entry or handoff an agent wrote. Stop fires at the
//      end of EVERY turn, so the bar is "newer than the last write", not "any
//      write this session" — the latter blocked only until the first entry.
//      Commit captures from the post-commit hook (source=hook) don't count as
//      logging: they record that code changed, not why.
//   2. Unlogged decision (opt-in, `session_check:` in config.yml): a numbered
//      decision added to decisions_file since decisions_base has no entry
//      citing "decision N".
//
// Hook contract (Claude Code): JSON on stdin with transcript_path and
// stop_hook_active; print {"decision":"block","reason":...} and exit 0 to hold
// the turn. stop_hook_active means this stop already follows a block, so it
// passes — the agent may decide nothing was worth keeping. It NEVER exits
// non-zero and never throws: a broken memory check must not break every turn.

const DEFAULT_DECISION_PATTERN = '^(\\d+)\\.\\s';
const DEFAULT_DECISIONS_BASE = 'origin/main';

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function toMs(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Session start = the first timestamped line of the transcript. The first few
// lines of a Claude Code transcript are metadata with no timestamp, so reading
// only line 1 (what the hand-written Mobile-Home-Parks hook did) never found a
// start and silently skipped the change check.
function sessionStart(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  let from = 0;
  for (let n = 0; n < 200 && from < text.length; n++) {
    const end = text.indexOf('\n', from);
    const line = text.slice(from, end === -1 ? text.length : end);
    from = end === -1 ? text.length : end + 1;
    try {
      const ts = line.trim() && JSON.parse(line).timestamp;
      const ms = ts ? toMs(ts) : null;
      if (ms != null) return ms;
    } catch {
      // torn or non-JSON line: keep looking
    }
  }
  return null;
}

// Newest local change in ms, or null. Commits only count when made since the
// session started (otherwise a pull would look like this session's work);
// dirty files count when modified since the start (or at all, without one).
function latestChange(cwd, startMs) {
  let latest = null;
  const bump = (ms) => { if (ms != null && (latest == null || ms > latest)) latest = ms; };

  if (startMs != null) {
    // Commit dates have whole-second resolution: compare at that resolution so
    // a commit in the session's first second still counts.
    const startSec = Math.floor(startMs / 1000) * 1000;
    const log = git(cwd, ['log', '--format=%cI', `--since=${new Date(startSec).toISOString()}`, '-n', '200']);
    for (const line of (log || '').split('\n')) {
      const ms = toMs(line.trim());
      if (ms != null && ms >= startSec) bump(ms);
    }
  }

  const top = (git(cwd, ['rev-parse', '--show-toplevel']) || '').trim();
  const status = top ? git(top, ['status', '--porcelain', '-z', '--untracked-files=all']) : null;
  if (status) {
    const parts = status.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (code[0] === 'R' || code[0] === 'C') i++; // -z puts the rename source next
      if (file === '.pebbl' || file.startsWith('.pebbl/')) continue;
      let ms;
      try {
        ms = fs.statSync(path.join(top, file)).mtimeMs;
      } catch {
        continue; // deleted: no mtime to compare
      }
      if (startMs == null || ms >= startMs) bump(ms);
    }
  }
  return latest;
}

// Newest pebbl write an agent (or human) made: entries other than commit
// captures, and handoff creates/closes.
function latestWrite(db) {
  const log = db.prepare("SELECT MAX(timestamp) AS t FROM logs WHERE source != 'hook'").get();
  const opened = db.prepare('SELECT MAX(timestamp) AS t FROM handoffs').get();
  const closed = db.prepare('SELECT MAX(closed_at) AS t FROM handoffs').get();
  const times = [log && log.t, opened && opened.t, closed && closed.t].map((t) => (t ? toMs(t) : null)).filter((t) => t != null);
  return times.length ? Math.max(...times) : null;
}

function handoffSince(db, startMs) {
  if (startMs == null) return false;
  const row = db.prepare('SELECT MAX(timestamp) AS t FROM handoffs').get();
  const t = row && row.t ? toMs(row.t) : null;
  return t != null && t >= startMs;
}

function decisionNumbers(text, pattern) {
  const out = new Set();
  let re;
  try {
    re = new RegExp(pattern, 'gm');
  } catch {
    return out;
  }
  for (const m of String(text).matchAll(re)) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n)) out.add(n);
  }
  return out;
}

// Decisions added to decisions_file since decisions_base with no entry citing
// "decision N". Skipped (returns []) when unconfigured, when the file is
// missing, or when the base can't be read — no base means every decision would
// look new, which is noise, not a finding.
function unloggedDecisions(db, root, cfg) {
  const file = cfg && cfg.decisions_file;
  if (!file) return [];
  let current;
  try {
    current = fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return [];
  }
  const base = git(root, ['show', `${cfg.decisions_base || DEFAULT_DECISIONS_BASE}:${file}`]);
  if (base == null) return [];
  const pattern = cfg.decision_pattern || DEFAULT_DECISION_PATTERN;
  const before = decisionNumbers(base, pattern);
  const added = [...decisionNumbers(current, pattern)].filter((n) => !before.has(n)).sort((a, b) => a - b);
  if (added.length === 0) return [];
  const messages = db.prepare('SELECT message FROM logs').all().map((r) => r.message).join('\n');
  return added.filter((n) => !new RegExp(`\\bdecision ${n}\\b`, 'i').test(messages));
}

// Pure decision for a given state, so tests don't need a transcript or a repo.
function verdict({ changeMs, writeMs, handoffThisSession, unlogged }) {
  const problems = [];
  if (unlogged && unlogged.length > 0) {
    problems.push(
      `Decisions added with no pebbl entry citing them: ${unlogged.join(', ')}. ` +
      'Log each one: pebbl log "<what>, because <why> (decision N)" --cat decision --topic <area>.'
    );
  }
  if (changeMs != null && (writeMs == null || changeMs > writeMs)) {
    problems.push(
      'Files changed since the last pebbl entry. Log each choice or failed approach as one line of what and ' +
      'why, pointing at where the detail lives' +
      (handoffThisSession ? '.' : ', and end the session with pebbl handoff "<one line>" --done "..." --todo "...".') +
      ' If nothing this turn is worth keeping, say so and stop.'
    );
  }
  return problems;
}

function checkSession() {
  const hook = readStdin();
  if (hook.stop_hook_active) return null;
  const pebblDir = findPebblDir();
  if (!pebblDir) return null;
  const root = path.dirname(pebblDir);
  const cwd = process.cwd();
  const cfg = (loadConfig(pebblDir) || {}).session_check || {};
  const startMs = sessionStart(hook.transcript_path);

  const db = openDb(pebblDir);
  try {
    const problems = verdict({
      changeMs: latestChange(cwd, startMs),
      writeMs: latestWrite(db),
      handoffThisSession: handoffSince(db, startMs),
      unlogged: unloggedDecisions(db, root, cfg),
    });
    return problems.length ? { decision: 'block', reason: problems.join(' ') } : null;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

module.exports = function checkSessionCli() {
  // Any failure passes the turn: stdout stays empty, exit code stays 0.
  let out = null;
  try {
    out = checkSession();
  } catch {
    out = null;
  }
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
};

module.exports._internal = { sessionStart, latestChange, latestWrite, unloggedDecisions, decisionNumbers, verdict };
