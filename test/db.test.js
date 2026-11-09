'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { topicFilter, openDb, openHandoffRowByKey } = require('../src/db');

describe('topicFilter', () => {
  it('returns correct SQL clause and params', () => {
    const { clause, params } = topicFilter('auth');
    assert(clause.includes('LIKE'));
    assert.strictEqual(params.length, 4);
    assert.strictEqual(params[0], '%,auth,%');
    assert.strictEqual(params[1], 'auth');
  });

  it('handles multi-word topics', () => {
    const { clause, params } = topicFilter('clip forge');
    assert(clause.includes('LIKE'));
    assert.strictEqual(params.length, 4);
    assert.strictEqual(params[0], '%,clip forge,%');
    assert.strictEqual(params[1], 'clip forge');
  });

  it('returns clause starting with AND', () => {
    const { clause } = topicFilter('test');
    assert(clause.startsWith('AND'));
  });
});

describe('openHandoffRowByKey', () => {
  // The read side of an events-mode store hands handoff.js a VIEW row whose id
  // is the fold's, not db.sqlite's; the db row is found by (timestamp, summary).
  it('finds the OPEN db row by (timestamp, summary), never by the id it was handed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-db-key-'));
    const db = openDb(dir);
    try {
      const ins = db.prepare('INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)');
      ins.run('2026-07-01T00:00:00.000Z', 'old wake', 'closed'); // db #1
      ins.run('2026-11-09T00:00:00.000Z', 'new wake', 'open');   // db #2
      // a view row that carries id 1 but IS the handoff db.sqlite holds as #2
      const hit = openHandoffRowByKey(db, { id: 1, timestamp: '2026-11-09T00:00:00.000Z', summary: 'new wake' });
      assert.equal(hit.id, 2);
      assert.equal(hit.summary, 'new wake');
      assert.equal(openHandoffRowByKey(db, { timestamp: '2026-07-01T00:00:00.000Z', summary: 'old wake' }), undefined,
        'a row already closed here is not returned');
      assert.equal(openHandoffRowByKey(db, { timestamp: '2026-11-09T00:00:00.000Z', summary: 'never here' }), undefined,
        'a handoff this db.sqlite never held has no row');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
