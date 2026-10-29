'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Everything pebbl installs OUTSIDE .pebbl/ that runs pebbl later: the five git
// hooks and the Claude Code Stop hook. One module so `init` and `upgrade` install
// byte-identical hooks (upgrade used to rewrite only post-commit, so a repo
// re-cloned without hooks got its commit capture back but not its privacy or
// rebuild hooks).

// ── pinning ──────────────────────────────────────────────────────────────────
// Every hook runs the EXACT pebbl that installed it, under the EXACT node that
// installed it — not whatever is first on $PATH. Two separate failure modes:
//   - a different pebbl on PATH (an older build without privacy-scan would
//     hard-block every commit);
//   - a different node on PATH (better-sqlite3 is built for one Node ABI; Node
//     24 fails with ERR_DLOPEN_FAILED, so a hook fired from a shell or GUI app
//     with another node silently captured nothing).
// realpath, not process.execPath: under fnm, execPath is a per-shell symlink
// dir (~/.local/state/fnm_multishells/<pid>_<ts>/bin/node) that vanishes when
// the shell exits. The hook falls back to PATH `node` if the pinned one is gone.
function pinnedBin() {
  return path.resolve(__dirname, '..', 'bin', 'pebbl.js');
}

function pinnedNode() {
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Shell lines that set $NODE to the pinned node, or PATH node if it's gone.
function nodeLines(node) {
  return `NODE=${shellQuote(node || '')}
[ -n "$NODE" ] && [ -x "$NODE" ] || NODE=node`;
}

// ── git hooks ────────────────────────────────────────────────────────────────

// post-commit: capture the commit into pebbl memory (`pebbl log-commit` writes
// the commit + log rows and appends commit-log.md so the commit is searchable).
// Falls back to a PATH `pebbl` only if the pinned bin is gone.
function postCommitHook(bin, node) {
  return `#!/bin/sh
# pebbl post-commit: capture the commit into pebbl memory.
HASH=$(git log -1 --pretty=%H)
MESSAGE=$(git log -1 --pretty=%B)
FILES=$(git diff-tree --no-commit-id -r --name-only HEAD | tr '\\n' ',')
# Pin the pebbl (and node) that installed this hook so commit-capture runs the
# INSTALLED code's log-commit, not a stale \`pebbl\` first on \$PATH.
PINNED=${shellQuote(bin || '')}
${nodeLines(node)}
if [ -n "$PINNED" ] && [ -f "$PINNED" ]; then
  exec "$NODE" "$PINNED" log-commit "$HASH" "$MESSAGE" "$FILES"
fi
pebbl log-commit "$HASH" "$MESSAGE" "$FILES"
`;
}

// post-merge / post-checkout: a merge or checkout can pull NEW events.jsonl
// lines, but the view is derived and gitignored. The hook only TOUCHES a
// sentinel; the rebuild is lazy on the next pebbl command (src/staleness.js),
// never inline — folding inside a git hook would make every pull slow.
const REBUILD_HOOK_SCRIPT = `#!/bin/sh
# pebbl P4: mark the view stale after a merge/checkout pulled new events.
# The rebuild itself is lazy — it happens on the next \`pebbl\` command, never
# here (folding inline would make every pull/checkout slow).
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -d "$ROOT/.pebbl" ] || exit 0
: > "$ROOT/.pebbl/.rebuild-needed" 2>/dev/null || true
exit 0
`;

// pre-commit / pre-push: the secret/PII forward gate. Resolution order:
//   1. the pinned bin under the pinned node, if the bin still exists,
//   2. else a repo-local node_modules/.bin/pebbl,
//   3. else a PATH `pebbl` ONLY IF it understands `privacy-scan` (probed),
//   4. else exit 0 (allow) — a hook that hard-fails on a missing/old binary
//      would block every commit and get deleted; audit-history is the backstop.
// PEBBL_SKIP_SCAN=1 is an explicit operator escape hatch.
function privacyHook(mode, bin, node) {
  const human = mode === '--push'
    ? 'pre-push secret/PII scan + public-repo hard gate. A PUBLIC remote blocks the\n# push until `pebbl audit-history` is clean (clears once clean; re-applies on a\n# once-private remote going public).'
    : 'pre-commit secret/PII scan. Refuses a commit that would write a non-RFC1918\n# IP+port, a credential file path, a token shape, or a denylisted name into\n# shared, append-only memory (which can never un-leak it).';
  return `#!/bin/sh
# pebbl P5: ${human}
[ -n "$PEBBL_SKIP_SCAN" ] && exit 0
PINNED=${shellQuote(bin || '')}
${nodeLines(node)}
if [ -n "$PINNED" ] && [ -f "$PINNED" ]; then
  exec "$NODE" "$PINNED" privacy-scan ${mode}
fi
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
if [ -x "$ROOT/node_modules/.bin/pebbl" ]; then
  exec "$ROOT/node_modules/.bin/pebbl" privacy-scan ${mode}
fi
# A PATH pebbl is used ONLY if it understands privacy-scan (an older global
# build that doesn't would otherwise hard-block every commit).
if command -v pebbl >/dev/null 2>&1 && pebbl help privacy-scan >/dev/null 2>&1; then
  exec pebbl privacy-scan ${mode}
fi
exit 0
`;
}

// The hooks dir for cwd's repo. `.git` is a FILE in a linked worktree, so ask
// git for the shared hooks path instead of assuming .git/hooks. null = not a repo.
function gitHooksDir(cwd) {
  const dotGit = path.join(cwd, '.git');
  if (!fs.existsSync(dotGit)) return null;
  if (fs.statSync(dotGit).isDirectory()) return path.join(dotGit, 'hooks');
  try {
    const p = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return p ? path.resolve(cwd, p) : null;
  } catch {
    return null;
  }
}

const GIT_HOOK_NAMES = ['post-commit', 'post-merge', 'post-checkout', 'pre-commit', 'pre-push'];

function gitHookBodies(bin = pinnedBin(), node = pinnedNode()) {
  return {
    'post-commit': postCommitHook(bin, node),
    'post-merge': REBUILD_HOOK_SCRIPT,
    'post-checkout': REBUILD_HOOK_SCRIPT,
    'pre-commit': privacyHook('--staged', bin, node),
    'pre-push': privacyHook('--push', bin, node),
  };
}

// Install (or refresh) all five hooks. Returns false when cwd isn't a git repo.
function installGitHooks(cwd, log = console.log) {
  const hooksDir = gitHooksDir(cwd);
  if (!hooksDir) return false;
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const [name, body] of Object.entries(gitHookBodies())) {
    const p = path.join(hooksDir, name);
    // writeFileSync's mode only applies on CREATE, so chmod to force +x on re-init.
    fs.writeFileSync(p, body, { mode: 0o755 });
    fs.chmodSync(p, 0o755);
  }
  log('Installed git hooks: post-commit (commit capture), post-merge + post-checkout (rebuild), pre-commit + pre-push (privacy scan)');
  return true;
}

// Health of the installed git hooks, for `pebbl doctor`. One row per hook:
// status 'ok' | 'missing' | 'foreign' (not pebbl's) | 'not-executable' |
// 'pinned-bin-missing' (pebbl's, but the pebbl it pins is gone).
function gitHookHealth(cwd) {
  const hooksDir = gitHooksDir(cwd);
  if (!hooksDir) return null;
  return GIT_HOOK_NAMES.map((name) => {
    const p = path.join(hooksDir, name);
    if (!fs.existsSync(p)) return { name, status: 'missing' };
    const body = fs.readFileSync(p, 'utf8');
    if (!/pebbl/.test(body)) return { name, status: 'foreign' };
    if ((fs.statSync(p).mode & 0o100) === 0) return { name, status: 'not-executable' };
    const m = /^PINNED='((?:[^']|'\\'')*)'/m.exec(body);
    const pinned = m ? m[1].replace(/'\\''/g, "'") : '';
    if (pinned && !fs.existsSync(pinned)) return { name, status: 'pinned-bin-missing', pinned };
    return { name, status: 'ok', pinned: pinned || null };
  });
}

// ── Claude Code ──────────────────────────────────────────────────────────────

// The Stop hook command. Written to .claude/settings.local.json, which Claude
// Code keeps out of git: the command holds this machine's absolute node and
// pebbl paths, exactly like the git hooks, so it is per-clone the same way.
// Never fails the turn: a missing pebbl exits 0.
function stopHookCommand(bin = pinnedBin(), node = pinnedNode()) {
  return `N=${shellQuote(node)}; B=${shellQuote(bin)}; [ -x "$N" ] || N=node; ` +
    `if [ -f "$B" ]; then exec "$N" "$B" check-session; fi; ` +
    `command -v pebbl >/dev/null 2>&1 && exec pebbl check-session; exit 0`;
}

const STOP_HOOK_MARK = 'check-session';

// Merge the Stop hook into .claude/settings.local.json. Never clobbers: other
// hooks and settings are kept, an existing pebbl entry is refreshed in place
// (so upgrade re-pins it), and an unparseable file is left alone with a warning.
// Returns 'added' | 'updated' | 'unchanged' | 'skipped'.
function installClaudeStopHook(cwd, log = console.log) {
  const dir = path.join(cwd, '.claude');
  const file = path.join(dir, 'settings.local.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      log('.claude/settings.local.json is not valid JSON — skipped the pebbl Stop hook');
      return 'skipped';
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      log('.claude/settings.local.json is not a JSON object — skipped the pebbl Stop hook');
      return 'skipped';
    }
  }
  const command = stopHookCommand();
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
  settings.hooks.Stop = stop;

  let result = 'added';
  for (const group of stop) {
    for (const h of (group && Array.isArray(group.hooks) ? group.hooks : [])) {
      if (h && typeof h.command === 'string' && h.command.includes(STOP_HOOK_MARK)) {
        result = h.command === command ? 'unchanged' : 'updated';
        h.command = command;
      }
    }
  }
  if (result === 'added') {
    stop.push({ hooks: [{ type: 'command', command, timeout: 30 }] });
  }
  if (result !== 'unchanged') {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  }
  const verb = { added: 'Added', updated: 'Updated', unchanged: 'Kept' }[result];
  log(`${verb} the pebbl Stop hook in .claude/settings.local.json (holds a turn that changed files without logging)`);
  return result;
}

// Make Claude Code load AGENTS.md. Claude Code reads CLAUDE.md, not AGENTS.md,
// so a repo with its own CLAUDE.md never saw the pebbl block (proxy-magic). Add
// an `@AGENTS.md` import under CLAUDE.md's first heading. Never creates
// CLAUDE.md, and skips one that IS AGENTS.md (a symlink) or already imports it.
// Returns true when it changed the file.
function ensureClaudeImport(cwd, log = console.log) {
  const claude = path.join(cwd, 'CLAUDE.md');
  const agents = path.join(cwd, 'AGENTS.md');
  if (!fs.existsSync(claude) || !fs.existsSync(agents)) return false;
  try {
    if (fs.realpathSync(claude) === fs.realpathSync(agents)) return false;
  } catch {
    return false;
  }
  const text = fs.readFileSync(claude, 'utf8');
  if (/^@AGENTS\.md\s*$/m.test(text)) return false;
  const lines = text.split('\n');
  const h1 = lines.findIndex((l) => /^# /.test(l));
  const at = h1 === -1 ? 0 : h1 + 1;
  const insert = h1 === -1 ? ['@AGENTS.md', ''] : ['', '@AGENTS.md'];
  lines.splice(at, 0, ...insert);
  fs.writeFileSync(claude, lines.join('\n'));
  log('Added @AGENTS.md to CLAUDE.md so Claude Code loads the pebbl guidance');
  return true;
}

module.exports = {
  pinnedBin,
  pinnedNode,
  postCommitHook,
  privacyHook,
  REBUILD_HOOK_SCRIPT,
  GIT_HOOK_NAMES,
  gitHooksDir,
  gitHookBodies,
  installGitHooks,
  gitHookHealth,
  stopHookCommand,
  installClaudeStopHook,
  ensureClaudeImport,
};
