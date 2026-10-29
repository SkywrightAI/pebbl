'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const init = require('../src/init');
const upgrade = require('../src/upgrade');
const eject = require('../src/eject');
const { AGENT_BEGIN, AGENT_END, AGENT_SECTION } = init;

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-iue-'));
}

function silence(fn) {
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try { return fn(); } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
  }
}

describe('init', () => {
  let dir, origCwd;
  before(() => { origCwd = process.cwd(); });
  beforeEach(() => {
    dir = tmpProject();
    process.chdir(dir);
  });
  after(() => { process.chdir(origCwd); });

  it('creates .pebbl/ with seed files', () => {
    silence(() => init());
    assert.ok(fs.existsSync(path.join(dir, '.pebbl')));
    assert.ok(fs.existsSync(path.join(dir, '.pebbl', 'manual-logs.md')));
    assert.ok(fs.existsSync(path.join(dir, '.pebbl', 'rubric.yml')));
    assert.ok(fs.existsSync(path.join(dir, '.pebbl', 'config.yml')));
  });

  it('writes AGENTS.md with sentinel-wrapped pebbl block', () => {
    silence(() => init());
    const md = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(md.includes(AGENT_BEGIN));
    assert.ok(md.includes(AGENT_END));
    assert.ok(md.indexOf(AGENT_BEGIN) < md.indexOf(AGENT_END));
  });

  it('does not create PEBBL.md at project root', () => {
    silence(() => init());
    assert.ok(!fs.existsSync(path.join(dir, 'PEBBL.md')));
  });

  it('AGENTS.md points to pebbl help instead of PEBBL.md', () => {
    silence(() => init());
    const md = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(!md.includes('PEBBL.md'));
    assert.match(md, /pebbl help <topic>/);
  });

  it('appends pebbl block to pre-existing AGENTS.md without clobbering', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Existing user content\n\nMy notes.\n');
    silence(() => init());
    const md = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(md.includes('My notes.'));
    assert.ok(md.includes(AGENT_BEGIN));
  });

  it('adds .pebbl/ to .gitignore', () => {
    silence(() => init());
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(gi, /\.pebbl\//);
  });
});

describe('upgrade', () => {
  let dir, origCwd;
  before(() => { origCwd = process.cwd(); });
  beforeEach(() => {
    dir = tmpProject();
    process.chdir(dir);
    silence(() => init());
  });
  after(() => { process.chdir(origCwd); });

  it('refreshes pebbl block in place without touching surrounding content', () => {
    const agentMd = path.join(dir, 'AGENTS.md');
    const tampered = fs.readFileSync(agentMd, 'utf8')
      .replace(AGENT_BEGIN + '\n', AGENT_BEGIN + '\nSTALE CONTENT\n');
    fs.writeFileSync(agentMd, '# user header\n\n' + tampered + '\n\n## user trailer\n');
    silence(() => upgrade());
    const after = fs.readFileSync(agentMd, 'utf8');
    assert.ok(!after.includes('STALE CONTENT'));
    assert.ok(after.includes('# user header'));
    assert.ok(after.includes('## user trailer'));
    assert.ok(after.includes(AGENT_BEGIN));
    assert.ok(after.includes(AGENT_END));
  });

  it('is idempotent — running twice yields the same AGENTS.md', () => {
    silence(() => upgrade());
    const first = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    silence(() => upgrade());
    const second = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.equal(first, second);
  });

  it('migrates legacy pebbl section to sentinel format', () => {
    const legacy = '# Agent Guidelines\n\n## Pebbl — Project Memory Protocol\n\nOld content here.\n\n## Other section\nUnrelated.\n';
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), legacy);
    silence(() => upgrade());
    const md = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(md.includes(AGENT_BEGIN));
    assert.ok(!md.includes('## Pebbl — Project Memory Protocol'));
    assert.ok(md.includes('## Other section'));
  });

  it('removes legacy PEBBL.md if present', () => {
    fs.writeFileSync(path.join(dir, 'PEBBL.md'), 'legacy content\n');
    silence(() => upgrade());
    assert.ok(!fs.existsSync(path.join(dir, 'PEBBL.md')));
  });
});

describe('eject', () => {
  let dir, origCwd;
  before(() => { origCwd = process.cwd(); });
  beforeEach(() => {
    dir = tmpProject();
    process.chdir(dir);
    silence(() => init());
  });
  after(() => { process.chdir(origCwd); });

  it('strips pebbl sentinel block from AGENTS.md, leaves user content', () => {
    const agentMd = path.join(dir, 'AGENTS.md');
    const before = fs.readFileSync(agentMd, 'utf8');
    fs.writeFileSync(agentMd, '# user header\n\n' + before + '\n\n## user trailer\n');
    silence(() => eject());
    const after = fs.readFileSync(agentMd, 'utf8');
    assert.ok(!after.includes(AGENT_BEGIN));
    assert.ok(!after.includes(AGENT_END));
    assert.ok(after.includes('# user header'));
    assert.ok(after.includes('## user trailer'));
  });

  it('removes legacy PEBBL.md if present', () => {
    fs.writeFileSync(path.join(dir, 'PEBBL.md'), 'legacy\n');
    silence(() => eject());
    assert.ok(!fs.existsSync(path.join(dir, 'PEBBL.md')));
  });

  it('removes .pebbl/ from .gitignore but leaves other entries', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.pebbl/\ndist/\n');
    silence(() => eject());
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(!gi.includes('.pebbl/'));
    assert.match(gi, /node_modules\//);
    assert.match(gi, /dist\//);
  });
});

describe('init: rendered AGENTS block, CLAUDE.md, narrative seed', () => {
  const { renderAgentSection, readmeNarrative } = init;
  let dir, origCwd;
  before(() => { origCwd = process.cwd(); });
  beforeEach(() => {
    dir = tmpProject();
    process.chdir(dir);
  });
  after(() => { process.chdir(origCwd); });

  it('renders the docs paragraph from handoff.docs / docs_dir', () => {
    assert.match(renderAgentSection({}), /doc in `docs\/handoffs\/`/);
    const never = renderAgentSection({ handoff: { docs: 'never' } });
    assert.match(never, /Don't write a handoff doc/);
    assert.doesNotMatch(never, /refuses/);
    const always = renderAgentSection({ handoff: { docs: 'always', docs_dir: 'docs/13 handoffs/' } });
    assert.match(always, /doc in `docs\/13 handoffs\/`/);
    assert.match(always, /refuses a handoff without `--docs`/);
    // an unknown mode falls back to the default
    assert.equal(renderAgentSection({ handoff: { docs: 'sometimes' } }), renderAgentSection({}));
  });

  it('upgrade re-renders the block from config.yml', () => {
    silence(() => init());
    const cfg = path.join(dir, '.pebbl', 'config.yml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('docs: when-heavy', 'docs: never'));
    silence(() => upgrade());
    assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /Don't write a handoff doc/);
  });

  it('adds @AGENTS.md to an existing CLAUDE.md', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Proj\n\nHouse rules.\n');
    silence(() => init());
    assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md$/m);
  });

  it('installs the Stop hook unless --no-claude-hooks', () => {
    silence(() => init(['--no-claude-hooks']));
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'settings.local.json')));
    silence(() => init());
    const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
    assert.match(s.hooks.Stop[0].hooks[0].command, /check-session/);
  });

  it('seeds an empty narrative from README and leaves a set one alone', () => {
    fs.writeFileSync(path.join(dir, 'README.md'),
      '# Thing\n\n[![ci](https://x/badge.svg)](https://x)\n\nThing tracks **park leases** and\n[tenant](docs/t.md) payments for our parks.\n\n## Install\n');
    silence(() => init());
    const body = fs.readFileSync(path.join(dir, '.pebbl', 'narrative.md'), 'utf8');
    assert.match(body, /Thing tracks park leases and tenant payments for our parks\./);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Thing\n\nSomething else entirely, long enough.\n');
    silence(() => init());
    assert.match(fs.readFileSync(path.join(dir, '.pebbl', 'narrative.md'), 'utf8'), /park leases/);
  });

  it('readmeNarrative returns null without a usable paragraph', () => {
    assert.equal(readmeNarrative(dir), null);
    fs.writeFileSync(path.join(dir, 'README.md'), '# T\n\n- a list\n- only\n');
    assert.equal(readmeNarrative(dir), null);
  });
});

describe('upgrade restores every git hook', () => {
  const { execFileSync } = require('child_process');
  let dir, origCwd;
  before(() => { origCwd = process.cwd(); });
  beforeEach(() => {
    dir = tmpProject();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    process.chdir(dir);
  });
  after(() => { process.chdir(origCwd); });

  it('a re-cloned repo with no hooks gets all five back from upgrade', () => {
    silence(() => init());
    const hooksDir = path.join(dir, '.git', 'hooks');
    for (const h of ['post-commit', 'post-merge', 'post-checkout', 'pre-commit', 'pre-push']) {
      fs.rmSync(path.join(hooksDir, h));
    }
    silence(() => upgrade());
    for (const h of ['post-commit', 'post-merge', 'post-checkout', 'pre-commit', 'pre-push']) {
      assert.ok(fs.existsSync(path.join(hooksDir, h)), `${h} restored`);
    }
  });
});

describe('upgrade seeds an empty narrative', () => {
  let dir, origCwd;
  before(() => { origCwd = process.cwd(); });
  beforeEach(() => {
    dir = tmpProject();
    process.chdir(dir);
  });
  after(() => { process.chdir(origCwd); });

  it('fills the placeholder from README on upgrade', () => {
    silence(() => init());
    fs.writeFileSync(path.join(dir, 'README.md'), '# P\n\nProxy cards for our own decks, printed at home.\n');
    silence(() => upgrade());
    assert.match(fs.readFileSync(path.join(dir, '.pebbl', 'narrative.md'), 'utf8'), /Proxy cards for our own decks/);
  });
});
