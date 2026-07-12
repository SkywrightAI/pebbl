'use strict';
const fs = require('fs');
const path = require('path');
const { findPebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { loadRubric, classifyEntry } = require('./rubric');
const { appendLogEvent } = require('./events');
const { rebuildEventsView } = require('./log');
// Projection-boundary secret mask: commit-log.md is committed + gate-scanned;
// the DB (commits/logs tables below) keeps the original commit message.
const { redact } = require('./privacy-scan');

module.exports = function logCommit(hash, message, files) {
  try {
    // Escape hatch for scripted/test environments, symmetric with the
    // pre-commit hook's PEBBL_SKIP_SCAN: a harness that makes git commits it
    // does NOT want captured into memory (e.g. the P0 merge tests, whose
    // committed events.jsonl would be dirtied right after every commit) sets
    // this to skip the whole capture.
    if (process.env.PEBBL_SKIP_CAPTURE) return;
    const pebblDir = findPebblDir();
    if (!pebblDir) return;

    const ts = new Date().toISOString();
    const shortHash = (hash || 'unknown').slice(0, 8);
    const msg = (message || '').trim().split('\n')[0];
    const fileList = (files || '').replace(/,$/, '');

    const rules = loadRubric(pebblDir);
    const classified = classifyEntry(rules, msg);
    const category = classified ? classified.category : 'uncategorized';
    const tier = 'fleeting';

    const md = `## ${ts} - ${shortHash}: ${redact(msg)}\n<!-- cat:${category} topic: tier:${tier} source:hook -->\n\nFiles: ${fileList || '(none)'}\n\n`;
    fs.appendFileSync(path.join(pebblDir, 'commit-log.md'), md);

    const db = openDb(pebblDir);
    db.prepare(`
      INSERT INTO commits (timestamp, hash, message, files)
      VALUES (?, ?, ?, ?)
    `).run(ts, hash, msg, fileList);

    db.prepare(`
      INSERT INTO logs (timestamp, source, category, tier, message, topics)
      VALUES (?, 'hook', ?, 'fleeting', ?, NULL)
    `).run(ts, category, msg);

    // The logs row above must ALSO exist in events.jsonl — this was the
    // fold/db id-drift write bug: log-commit inserted db-only rows, so
    // db.sqlite's AUTOINCREMENT ids ran ahead of the fold's renumbered ids
    // and every later row mismapped in compact's eid translation (and the
    // phantom rows themselves vanished on the next rebuild-from-events).
    // Same append+rebuild seam log.js uses (appendLogEvent under the store
    // lock, rebuildEventsView for the folded artifacts); the surrounding
    // try/catch keeps the never-block-a-commit contract.
    appendLogEvent(
      pebblDir,
      { ts, category, tier: 'fleeting', message: msg, source: 'hook' },
      (rows) => rebuildEventsView(pebblDir, rows),
    );
  } catch {
    // Never block a commit
  }
};
