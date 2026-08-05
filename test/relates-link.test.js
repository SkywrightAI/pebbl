'use strict';
// `pebbl log --relates N` must SURVIVE. Before this suite the flag wrote
// logs.relates_to into db.sqlite and stopped there: the relation never reached
// events.jsonl, so in an events-canonical store (where events.jsonl IS the
// source and db.sqlite is a rebuildable projection) the link was invisible to
// every read and vanished on the next rebuild. The write looked like it worked.
//
// It also covers the half that made the flag unusable even when it did persist:
// the id it wants had to be discoverable, and an eid — the only identity that
// means the same thing in another clone — had to be accepted.
//
// Acceptance:
//   1. --relates lands on the wire (events.jsonl) as an EID, not a local int.
//   2. the relation shows in the events read model and SURVIVES `pebbl rebuild`.
//   3. an eid is accepted as the ref, not just a local int.
//   4. --corrects and --relates are orthogonal: both links ride one entry.
//   5. a garbage ref is rejected loudly; an unresolvable one degrades to an
//      unlinked entry rather than losing the entry.
//   6. an entry with no relation serializes exactly as before (no new key).
//   7. the id needed for the flag is actually printed at log time.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-relates-'));
}
function gitInit(cwd) {
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd });
}
function pebbl(cwd, args) {
  return execFileSync('node', [PEBBL_BIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
// An events-canonical store: `init --shared` writes the .events-canonical
// marker, which is what makes events.jsonl the source rather than a tracer.
function newEventsStore() {
  const dir = tmpDir();
  gitInit(dir);
  pebbl(dir, ['init', '--shared']);
  assert.ok(fs.existsSync(path.join(dir, '.pebbl', '.events-canonical')),
    'fixture must be an events-canonical store');
  return dir;
}
function events(dir) {
  return fs.readFileSync(path.join(dir, '.pebbl', 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
// The events-mode read model: view.sqlite is the fold of events.jsonl, and it
// is what `context`/`search` read. Asserting here (not on db.sqlite) is the
// point — db.sqlite held the relation all along while the user saw nothing.
function viewRows(dir) {
  const db = new Database(path.join(dir, '.pebbl', 'view.sqlite'), { readonly: true });
  const rows = db.prepare('SELECT id, message, relates_to, corrects FROM logs ORDER BY id').all();
  db.close();
  return rows;
}
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('log --relates', () => {
  it('puts an EID on the wire and shows the link in the events read model', () => {
    const dir = newEventsStore();
    pebbl(dir, ['log', 'entry A the original', '--cat', 'decision', '--tier', 'component']);
    pebbl(dir, ['log', 'entry B sees also A', '--cat', 'decision', '--tier', 'component', '--relates', '1']);

    const evs = events(dir);
    const b = evs.find((e) => (e.message || '').startsWith('entry B'));
    const a = evs.find((e) => (e.message || '').startsWith('entry A'));

    // THE REGRESSION: this field did not exist on the event at all.
    assert.ok(b.relates_to, '--relates must reach events.jsonl');
    assert.match(b.relates_to, ULID_RE, 'the wire form must be an eid, never a local int');
    assert.equal(b.relates_to, a.eid, 'must point at entry A');

    const rows = viewRows(dir);
    assert.equal(rows.find((r) => r.message.startsWith('entry B')).relates_to, 1,
      'the fold must translate the eid back to the local int the read model shows');
  });

  it('keeps the relation across a rebuild-from-events', () => {
    const dir = newEventsStore();
    pebbl(dir, ['log', 'target entry', '--cat', 'decision', '--tier', 'component']);
    pebbl(dir, ['log', 'linking entry', '--cat', 'decision', '--tier', 'component', '--relates', '1']);

    const before = viewRows(dir).find((r) => r.message === 'linking entry').relates_to;
    assert.equal(before, 1);

    // The projection is disposable by design; the log is the record. A relation
    // that only lived in db.sqlite disappeared exactly here.
    pebbl(dir, ['rebuild']);

    const after = viewRows(dir).find((r) => r.message === 'linking entry').relates_to;
    assert.equal(after, 1, 'the relation must survive a rebuild — events.jsonl is the source');
  });

  it('accepts an eid as the ref, not just a local int', () => {
    const dir = newEventsStore();
    pebbl(dir, ['log', 'first entry', '--cat', 'decision', '--tier', 'component']);
    const targetEid = events(dir).find((e) => e.message === 'first entry').eid;

    // An agent reading events.jsonl only ever sees the eid; rejecting it (the
    // old integer-only guard) left no usable way to link programmatically.
    pebbl(dir, ['log', 'second entry', '--cat', 'decision', '--tier', 'component', '--relates', targetEid]);

    const second = events(dir).find((e) => e.message === 'second entry');
    assert.equal(second.relates_to, targetEid);
    assert.equal(viewRows(dir).find((r) => r.message === 'second entry').relates_to, 1);
  });

  it('carries --corrects and --relates on the same entry (orthogonal links)', () => {
    const dir = newEventsStore();
    pebbl(dir, ['log', 'old belief', '--cat', 'decision', '--tier', 'component']);
    pebbl(dir, ['log', 'side context', '--cat', 'decision', '--tier', 'component']);
    pebbl(dir, ['log', 'new belief', '--cat', 'decision', '--tier', 'component',
      '--corrects', '1', '--relates', '2']);

    const evs = events(dir);
    const nb = evs.find((e) => e.message === 'new belief');
    assert.equal(nb.type, 'correct', 'a --corrects entry stays a correct event');
    assert.equal(nb.corrects, evs.find((e) => e.message === 'old belief').eid);
    assert.equal(nb.relates_to, evs.find((e) => e.message === 'side context').eid,
      'the see-also must ride the correct event too');
  });

  it('rejects a malformed ref loudly and never stores it', () => {
    const dir = newEventsStore();
    pebbl(dir, ['log', 'anchor', '--cat', 'decision', '--tier', 'component']);
    assert.throws(
      () => pebbl(dir, ['log', 'bad ref', '--cat', 'decision', '--relates', 'not-an-id']),
      (err) => /--relates expects an entry id/.test(String(err.stderr)),
    );
    assert.equal(events(dir).filter((e) => e.message === 'bad ref').length, 0,
      'a rejected ref must not leave a half-written entry');
  });

  it('degrades to an unlinked entry when the ref resolves to nothing', () => {
    const dir = newEventsStore();
    // Well-formed but dangling: losing the link is recoverable, losing the
    // entry is not, so the write proceeds without the relation.
    pebbl(dir, ['log', 'orphan link', '--cat', 'decision', '--tier', 'component', '--relates', '999']);
    const e = events(dir).find((x) => x.message === 'orphan link');
    assert.ok(e, 'the entry itself must still be stored');
    assert.equal(e.relates_to, undefined, 'no relation stamped for an unresolvable ref');
  });

  it('adds no key to an entry that has no relation', () => {
    const dir = newEventsStore();
    pebbl(dir, ['log', 'plain entry', '--cat', 'decision', '--tier', 'component']);
    const e = events(dir).find((x) => x.message === 'plain entry');
    // Present-only tail: an unrelated entry must serialize as it always did, or
    // every existing line in every store counts as changed.
    assert.ok(!('relates_to' in e), 'relates_to must be absent, not null, when unused');
  });

  it('prints the entry id that --relates needs', () => {
    const dir = newEventsStore();
    const out = pebbl(dir, ['log', 'findable entry', '--cat', 'decision', '--tier', 'component']);
    // `pebbl help entry-ids` promises an id "printed at log time"; without it
    // there is no way to discover the number the flag demands.
    assert.match(out, /#1\b/, 'log must print the entry id');

    const found = pebbl(dir, ['search', 'findable']);
    assert.match(found, /#1\b/, 'search must print the entry id');
  });
});
