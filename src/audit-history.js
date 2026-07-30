'use strict';
// P5 -- `pebbl audit-history`: the one-time, READ-ONLY backward scan over ALL
// committed `.md` history. The forward git hooks only see NEW commits/pushes;
// the design's Precondition (notes/design-event-sourcing-2026-06-17.md lines
// 56-58) is that the leak is ALREADY in committed git history -- sw-factory's
// tracked manual-logs.md carries the droplet IP+port, the sk-ant token shape,
// and four credential paths across 174 commits. Before any store goes
// `--shared`, an operator must SEE every historical leak and decide
// rotate-vs-accept per finding.
//
// This command makes ZERO changes to git history or the working tree. It walks
// `git log --all` for every blob of every tracked `*.md` file, runs the shared
// 3-class detector (src/privacy-scan.js) per line, and prints a rotation
// checklist: file, commit, line, class, and a rotate-vs-accept prompt. It never
// edits, redacts, force-pushes, or stages anything -- append-only memory can't
// forget, so a real leak must be ROTATED by a human, never "fixed" by this tool.
//
// Modeled on src/scan-commits.js: pure core (collect blobs, run detector),
// separated from the CLI shell, never auto-acts. The git plumbing uses
// `git log` / `git show` exactly like scan-commits' execSync(git log) pattern.

const { execFileSync } = require('child_process');
const path = require('path');
const { findPebblDir } = require('./find-pebbl');
const { scan, loadDenylist } = require('./privacy-scan');
const { parseArgs, assertCompleteFlags } = require('./args');
const {
  loadLedger, saveLedger, toEntry, partition, groupByFingerprint, resolveId,
} = require('./audit-ledger');

// Run a git command in repoRoot, returning stdout (or '' on failure). Read-only
// by construction -- every call is a `log`/`ls-tree`/`show`, never a mutation.
function git(repoRoot, args) {
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

// Every (commit, path) pair where a tracked *.md blob existed, across ALL refs.
// `git log --all --name-only --format=%H --diff-filter=d` lists, per commit, the
// .md paths touched. We pair each touched .md path with the commit so we scan
// the blob AS IT WAS at that commit (catches a leak that was later deleted from
// the working tree but still lives in history -- the whole point).
function collectMdBlobs(repoRoot, git_) {
  const g = git_ || ((args) => git(repoRoot, args));
  const out = g(['log', '--all', '--no-merges', '--diff-filter=AM', '--name-only', '--format=%x00%H']);
  const pairs = [];
  let commit = null;
  for (const lineRaw of out.split('\n')) {
    const line = lineRaw.replace(/\r$/, '');
    if (line.startsWith('\x00')) {
      commit = line.slice(1).trim();
      continue;
    }
    const p = line.trim();
    if (!commit || !p) continue;
    if (!/\.md$/i.test(p)) continue;
    pairs.push({ commit, path: p });
  }
  // Dedupe identical (commit, path) -- a path can appear once per commit already,
  // but a defensive Set keeps the scan from double-reporting.
  const seen = new Set();
  const deduped = [];
  for (const pr of pairs) {
    const k = `${pr.commit}:${pr.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(pr);
  }
  return deduped;
}

// Read one blob's content at a specific commit (`git show <commit>:<path>`).
function showBlob(repoRoot, commit, p, git_) {
  const g = git_ || ((args) => git(repoRoot, args));
  return g(['show', `${commit}:${p}`]);
}

// Pure core: given the list of (commit, path) pairs and a blob reader, run the
// detector over every blob and return a flat findings list. Each finding is one
// (file, commit, line, class, match) the operator must rotate-or-accept.
// `readBlob(commit, path) -> string` is injected so tests need no real git.
function auditBlobs(pairs, readBlob, opts = {}) {
  const denylist = loadDenylist(opts);
  const findings = [];
  for (const { commit, path: p } of pairs) {
    const text = readBlob(commit, p);
    if (!text) continue;
    const hits = scan(text, { ...opts, _denylist: denylist });
    for (const h of hits) {
      findings.push({
        file: p,
        commit: commit.slice(0, 12),
        line: h.line,
        class: h.class,
        match: h.match,
        detail: h.detail,
      });
    }
  }
  return findings;
}

// Format the rotation checklist. One block per finding with a rotate-vs-accept
// prompt. PURE -- returns a string, prints nothing, changes nothing.
//
// `accepted` are findings the operator has already decided about (see
// src/audit-ledger.js). They are printed in their own section rather than
// hidden: an accept is a security decision, and a decision you can no longer
// see is a decision you can no longer revisit. Only the UNACCEPTED findings
// carry the rotate-vs-accept prompt, because only those still block a push.
function formatChecklist(findings, accepted = [], ledgerError = null) {
  const lines = [];
  if (ledgerError) {
    lines.push('');
    lines.push(`pebbl audit-history: WARNING -- the accept ledger could not be read (${ledgerError}).`);
    lines.push('Treating every finding as UNACCEPTED (fail closed). Fix or delete the ledger file.');
  }

  if (findings.length === 0) {
    lines.push(accepted.length === 0
      ? 'pebbl audit-history: no leak found in committed .md history. (Clean -- safe to consider --shared.)'
      : `pebbl audit-history: no UNACCEPTED leak in committed .md history. (${accepted.length} previously accepted; --list-accepted to review.)`);
    return lines.join('\n');
  }

  const groups = groupByFingerprint(findings);
  lines.push('');
  lines.push(`pebbl audit-history -- ${groups.length} unaccepted potential leak${groups.length === 1 ? '' : 's'} in committed .md history.`);
  lines.push('READ-ONLY: nothing was changed. Append-only memory cannot forget -- a real');
  lines.push('secret in history is in every clone/fork forever and must be ROTATED, not redacted.');
  lines.push('Decide ROTATE (the secret is live) or ACCEPT (already dead / not sensitive) per finding:');
  lines.push('');
  // group by class for a readable checklist
  const byClass = new Map();
  for (const g of groups) {
    if (!byClass.has(g.class)) byClass.set(g.class, []);
    byClass.get(g.class).push(g);
  }
  for (const [cls, group] of byClass) {
    lines.push(`## ${cls}  (${group.length})`);
    for (const g of group) {
      lines.push(`  [ ] ROTATE / ACCEPT  ${g.match}   (id ${g.id})`);
      const where = g.commits.length === 1
        ? `@ ${g.commits[0]}`
        : `@ ${g.commits.length} commits`;
      lines.push(`        ${g.detail} -- ${g.file}:${g.lines.join(',')} ${where}`);
    }
    lines.push('');
  }
  lines.push('Next: for each ROTATE, rotate the credential/secret at its source (the audit');
  lines.push('does NOT and CANNOT do this). This scan never edited git history or any file.');
  lines.push('');
  lines.push('For each ACCEPT (already public / already dead / not a secret), record it so the');
  lines.push('pre-push gate stops re-asking -- a NEW leak still blocks after this:');
  lines.push('  pebbl audit-history --accept <id> --reason "why this is safe to accept"');
  lines.push('  pebbl audit-history --accept all --reason "..."   (every finding above)');
  if (accepted.length) {
    lines.push('');
    lines.push(`(${accepted.length} finding${accepted.length === 1 ? '' : 's'} already accepted and not shown -- pebbl audit-history --list-accepted)`);
  }
  return lines.join('\n');
}

// Render the ledger for `--list-accepted`. An accepted finding stays fully
// visible and revocable; this is the "show your work" view.
function formatAccepted(acceptedMap) {
  const entries = Array.from(acceptedMap.values());
  if (entries.length === 0) {
    return 'pebbl audit-history: no accepted findings recorded. (The pre-push gate blocks on every finding.)';
  }
  const lines = [''];
  lines.push(`pebbl audit-history -- ${entries.length} accepted finding${entries.length === 1 ? '' : 's'} (these no longer block a push):`);
  lines.push('');
  for (const e of entries) {
    // A token-class entry deliberately stores no `match` -- the ledger is a
    // committed file and must never carry the secret it exempts.
    const shown = e.match || '(value withheld -- token class)';
    lines.push(`  ${e.id}  [${e.class}]  ${shown}`);
    lines.push(`      ${e.file}`);
    lines.push(`      accepted ${e.acceptedAt}: ${e.reason}`);
  }
  lines.push('');
  lines.push('To un-accept one (it will block pushes again):  pebbl audit-history --revoke <id>');
  return lines.join('\n');
}

module.exports = function auditHistory(args) {
  const parsed = parseArgs(Array.isArray(args) ? args : []);
  assertCompleteFlags(parsed);
  const { flags } = parsed;

  const pebblDir = findPebblDir();
  // repoRoot is the dir that holds .pebbl/ (or cwd if not inside a store -- the
  // audit is about git history, so it still works without a .pebbl/).
  const pebblRoot = pebblDir ? path.dirname(path.resolve(pebblDir)) : process.cwd();
  // The ledger records decisions about GIT history, so it belongs to the git
  // repo, not to whatever directory happens to hold .pebbl/ (which may be a
  // symlink pointing outside the worktree). Fall back to pebblRoot when the
  // toplevel can't be resolved.
  const repoRoot = git(pebblRoot, ['rev-parse', '--show-toplevel']).trim() || pebblRoot;

  // Confirm we're in a git repo; otherwise there's no committed history to scan.
  const inside = git(repoRoot, ['rev-parse', '--is-inside-work-tree']).trim();
  if (inside !== 'true') {
    console.error('pebbl audit-history: not inside a git repository -- nothing to scan.');
    process.exit(1);
  }

  const ledger = loadLedger(repoRoot);

  if (flags['list-accepted']) {
    if (ledger.error) {
      console.error(`pebbl audit-history: the accept ledger at ${ledger.path} is unreadable (${ledger.error}).`);
      process.exit(1);
    }
    console.log(formatAccepted(ledger.accepted));
    return;
  }

  const opts = { pebblDir: pebblDir || undefined, repoRoot };
  const pairs = collectMdBlobs(repoRoot);
  const allFindings = auditBlobs(pairs, (commit, p) => showBlob(repoRoot, commit, p), opts);
  const { blocking, accepted } = partition(allFindings, ledger.accepted);

  const toRevoke = flags.revoke ? [].concat(flags.revoke) : [];
  const toAccept = flags.accept ? [].concat(flags.accept) : [];

  if (toRevoke.length) {
    // Revoking is the un-accept path. It only ever makes the gate STRICTER, so
    // it needs no reason and is safe to run on a ledger you didn't write.
    if (ledger.error) {
      console.error(`pebbl audit-history: refusing to edit an unreadable ledger (${ledger.error}).`);
      process.exit(1);
    }
    const ids = Array.from(ledger.accepted.keys());
    for (const prefix of toRevoke) {
      const { id, error } = resolveId(prefix, ids);
      if (error) {
        console.error(`pebbl audit-history: ${error}`);
        process.exit(1);
      }
      ledger.accepted.delete(id);
      console.log(`revoked ${id} -- it will block a public push again.`);
    }
    saveLedger(repoRoot, ledger.accepted);
    console.log(`Ledger written: ${ledger.path}  (commit it so a clone inherits the decision.)`);
    return;
  }

  if (toAccept.length) {
    // An accept LOOSENS the gate, so it carries the two guards a loosening
    // needs: a written reason, and a refusal to edit a ledger we couldn't parse
    // (silently rewriting a corrupt accept-list would drop decisions we can't
    // even see).
    if (ledger.error) {
      console.error(`pebbl audit-history: refusing to edit an unreadable ledger (${ledger.error}).`);
      process.exit(1);
    }
    const reason = typeof flags.reason === 'string' ? flags.reason.trim() : '';
    if (!reason) {
      console.error('pebbl audit-history: --accept requires --reason "why this is safe to accept".');
      console.error('An accept is a security decision that outlives the session; an unexplained');
      console.error('one is a rubber stamp. Say why (already public / already dead / not a secret).');
      process.exit(1);
    }
    const groups = groupByFingerprint(blocking);
    if (groups.length === 0) {
      console.log('pebbl audit-history: nothing to accept -- no unaccepted findings.');
      return;
    }
    const wantsAll = toAccept.some((a) => a === 'all');
    let targets;
    if (wantsAll) {
      targets = groups;
    } else {
      targets = [];
      const ids = groups.map((g) => g.id);
      for (const prefix of toAccept) {
        const { id, error } = resolveId(prefix, ids);
        if (error) {
          console.error(`pebbl audit-history: ${error}`);
          process.exit(1);
        }
        targets.push(groups.find((g) => g.id === id));
      }
    }
    const now = new Date().toISOString();
    for (const g of targets) {
      ledger.accepted.set(g.id, toEntry(g, reason, now));
      const shown = g.class === 'token' ? '(value withheld -- token class)' : g.match;
      console.log(`accepted ${g.id}  [${g.class}]  ${shown}`);
    }
    saveLedger(repoRoot, ledger.accepted);
    console.log('');
    console.log(`Ledger written: ${ledger.path}`);
    console.log('Commit it so a clone inherits the decision. A NEW leak still blocks the push.');
    return;
  }

  console.log(formatChecklist(blocking, accepted, ledger.error));
  // Read-only: a non-zero exit would be reasonable to flag "leaks found" in CI,
  // but this is an operator review command, not a gate -- exit 0 so it composes
  // in a pipeline. The FORWARD hooks (pre-commit/pre-push) are the gate.
};

module.exports._internal = {
  collectMdBlobs,
  auditBlobs,
  formatChecklist,
  formatAccepted,
  showBlob,
};
