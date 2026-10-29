'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const hooks = require('../src/hooks');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const quiet = () => {};

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function mkrepo() {
  const repo = tmp('pebbl-hooksjs-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

describe('pinning', () => {
  it('pinnedNode is a real (non-symlink) executable path', () => {
    const n = hooks.pinnedNode();
    assert.equal(fs.realpathSync(n), n);
  });

  it('git hooks pin both the node and the pebbl bin, with a PATH node fallback', () => {
    const body = hooks.postCommitHook('/x/bin/pebbl.js', '/x/node');
    assert.match(body, /^PINNED='\/x\/bin\/pebbl\.js'$/m);
    assert.match(body, /^NODE='\/x\/node'$/m);
    assert.match(body, /\|\| NODE=node/);
    assert.match(body, /exec "\$NODE" "\$PINNED" log-commit/);
  });

  it('shell-quotes paths with spaces and quotes', () => {
    const body = hooks.privacyHook('--staged', "/a b/it's/pebbl.js", '/n');
    assert.match(body, /PINNED='\/a b\/it'\\''s\/pebbl\.js'/);
  });

  it('a hook whose pinned node is gone still runs under PATH node', () => {
    const repo = mkrepo();
    try {
      const body = hooks.privacyHook('--staged', BIN, '/nonexistent/node');
      const p = path.join(repo, 'hook');
      fs.writeFileSync(p, body, { mode: 0o755 });
      // nothing staged -> privacy-scan passes; the point is it ran, not 127.
      execFileSync(p, { cwd: repo, stdio: 'ignore' });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('installGitHooks / gitHookHealth', () => {
  it('installs all five hooks executable, and health reports ok', () => {
    const repo = mkrepo();
    try {
      assert.equal(hooks.installGitHooks(repo, quiet), true);
      const health = hooks.gitHookHealth(repo);
      assert.deepEqual(health.map((h) => h.name), hooks.GIT_HOOK_NAMES);
      for (const h of health) assert.equal(h.status, 'ok', `${h.name}: ${h.status}`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns false outside a git repo', () => {
    const dir = tmp('pebbl-nogit-');
    try {
      assert.equal(hooks.installGitHooks(dir, quiet), false);
      assert.equal(hooks.gitHookHealth(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('health flags missing, foreign and stale-pin hooks', () => {
    const repo = mkrepo();
    try {
      const dir = path.join(repo, '.git', 'hooks');
      fs.writeFileSync(path.join(dir, 'post-commit'), '#!/bin/sh\necho other tool\n', { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'pre-commit'), hooks.privacyHook('--staged', '/gone/pebbl.js', '/n'), { mode: 0o755 });
      const by = Object.fromEntries(hooks.gitHookHealth(repo).map((h) => [h.name, h.status]));
      assert.equal(by['post-commit'], 'foreign');
      assert.equal(by['pre-commit'], 'pinned-bin-missing');
      assert.equal(by['pre-push'], 'missing');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('installs into the shared hooks dir from a linked worktree', () => {
    const repo = mkrepo();
    try {
      execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo });
      const wt = path.join(repo, '.worktrees', 'w');
      execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: repo });
      assert.equal(hooks.installGitHooks(wt, quiet), true);
      assert.ok(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit')));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('installClaudeStopHook', () => {
  const file = (dir) => path.join(dir, '.claude', 'settings.local.json');

  it('creates settings.local.json with one Stop hook', () => {
    const dir = tmp('pebbl-claude-');
    try {
      assert.equal(hooks.installClaudeStopHook(dir, quiet), 'added');
      const s = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
      assert.equal(s.hooks.Stop.length, 1);
      assert.match(s.hooks.Stop[0].hooks[0].command, /check-session/);
      assert.equal(hooks.installClaudeStopHook(dir, quiet), 'unchanged');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps other settings and hooks, and re-pins an existing pebbl entry in place', () => {
    const dir = tmp('pebbl-claude-');
    try {
      fs.mkdirSync(path.join(dir, '.claude'));
      fs.writeFileSync(file(dir), JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        hooks: { Stop: [{ hooks: [
          { type: 'command', command: 'bin/park-check' },
          { type: 'command', command: '/old/node /old/pebbl.js check-session' },
        ] }] },
      }));
      assert.equal(hooks.installClaudeStopHook(dir, quiet), 'updated');
      const s = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
      assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
      assert.equal(s.hooks.Stop.length, 1);
      const cmds = s.hooks.Stop[0].hooks.map((h) => h.command);
      assert.equal(cmds[0], 'bin/park-check');
      assert.equal(cmds[1], hooks.stopHookCommand());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an unparseable settings file alone', () => {
    const dir = tmp('pebbl-claude-');
    try {
      fs.mkdirSync(path.join(dir, '.claude'));
      fs.writeFileSync(file(dir), '{ nope');
      assert.equal(hooks.installClaudeStopHook(dir, quiet), 'skipped');
      assert.equal(fs.readFileSync(file(dir), 'utf8'), '{ nope');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the hook command exits 0 when pebbl is nowhere', () => {
    const cmd = hooks.stopHookCommand('/gone/pebbl.js', '/gone/node');
    execFileSync('sh', ['-c', cmd], { input: '{}', env: { PATH: '/usr/bin:/bin' } });
  });
});

describe('ensureClaudeImport', () => {
  it('adds @AGENTS.md under the first heading, once', () => {
    const dir = tmp('pebbl-import-');
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# A\n');
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project\n\nRules here.\n');
      assert.equal(hooks.ensureClaudeImport(dir, quiet), true);
      assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# Project\n\n@AGENTS.md\n\nRules here.\n');
      assert.equal(hooks.ensureClaudeImport(dir, quiet), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never creates CLAUDE.md and skips a CLAUDE.md that is AGENTS.md', () => {
    const dir = tmp('pebbl-import-');
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# A\n');
      assert.equal(hooks.ensureClaudeImport(dir, quiet), false);
      assert.ok(!fs.existsSync(path.join(dir, 'CLAUDE.md')));
      fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'));
      assert.equal(hooks.ensureClaudeImport(dir, quiet), false);
      assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# A\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
