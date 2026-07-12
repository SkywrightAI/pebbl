'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb, notCorrected } = require('./db');
const { loadConfig, ensureProjectFiles } = require('./rubric');
const {
  readEvents,
  foldFull,
  appendEvent,
  appendEventBatch,
  makeSupersedeEvent,
  makeResolveEvent,
  makeExpireEvent,
  makeAppendEvent,
  makeCommitEvent,
  makeEnvelope,
} = require('./events');
const {
  renderManualLogsMd,
  renderHandoffsMd,
  renderNarrativeMd,
  renderCommitLogMd,
  writeViewSqlite,
} = require('./view');
// Projection-boundary secret mask, reused at every db -> .md render path so the
// committed markdown can't trip the promote gate (the .md emitters in view.js
// the rebuild path above uses are already masked; regenerateMarkdown below is
// the one db.sqlite-driven loop that doesn't route through them).
const { redact } = require('./privacy-scan');

// Quarter label for a timestamp, e.g. "2026-04-15..." → "2026-Q2". Used as the
// compactor bucket's time dimension (see key construction below).
function quarterOf(timestamp) {
  const ts = timestamp || '';
  const year = ts.slice(0, 4);
  const month = parseInt(ts.slice(5, 7), 10);
  const q = month >= 1 && month <= 12 ? Math.ceil(month / 3) : 1;
  return `${year}-Q${q}`;
}

function buildGroups(db, threshold, componentThreshold) {
  // notCorrected(): never count or roll up a superseded entry (one another
  // entry corrects). Same exclusion the nag and context views use — DRY.
  //
  // corrects IS NULL: also leave the CORRECTING entry out of rollups. A rollup
  // INSERT writes corrects=NULL (one row can't carry many edges), so folding a
  // correcting entry would drop its corrects edge and resurface the entry it
  // superseded. Keeping correcting entries live preserves the edge — the
  // guardrail "rollups must NOT drop corrects edges."
  const rows = db.prepare(`
    SELECT * FROM logs
    WHERE tier IN ('component', 'detail', 'fleeting')
      AND corrects IS NULL
      AND ${notCorrected()}
    ORDER BY timestamp
  `).all();

  const groups = new Map();
  const ambiguous = [];
  const fleeting = [];
  const protectedDecisions = [];

  for (const row of rows) {
    if (row.tier === 'fleeting') {
      fleeting.push(row);
      continue;
    }

    if (row.category === 'uncategorized') {
      ambiguous.push(row);
      continue;
    }

    // A component-tier decision is a high-value, retrievable fact. Rolling it
    // into a detail rollup demotes its tier and drops it from the topic index
    // — a self-inflicted recall miss. Pull it out for an explicit keep/rollup
    // decision instead of compacting it silently.
    if (row.tier === 'component' && row.category === 'decision') {
      protectedDecisions.push(row);
      continue;
    }

    const primaryTopic = (row.topics || 'general').split(',')[0].trim();
    // Bucket by QUARTER, not month. A long-lived topic that earns a few entries
    // a month never crossed a per-MONTH threshold, so it was permanently
    // uncompactable — the nag promised compaction the executor could never
    // deliver. A quarter widens the window ~3x while keeping a meaningful time
    // label on each rollup (we still archive every source entry, so no history
    // is lost). Chose quarter over "drop month + cap size" because the temporal
    // label is useful in `[rollup] ... (2026-Q2)` and the existing archive-first
    // path already caps blast radius per group.
    const key = `${row.category}/${primaryTopic}/${quarterOf(row.timestamp)}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const qualified = new Map();
  for (const [key, entries] of groups) {
    const componentCount = entries.filter(e => e.tier === 'component').length;
    const isComponentGroup = componentCount > entries.length / 2;
    const effectiveThreshold = isComponentGroup ? componentThreshold : threshold;

    if (entries.length >= effectiveThreshold) {
      qualified.set(key, entries);
    }
  }

  return { groups: qualified, ambiguous, fleeting, protected: protectedDecisions };
}

// Union of every source entry's topics (deduped, order-preserving). A rollup
// must carry ALL its entries' topics, not just the first entry's primary topic,
// or the rolled-up history vanishes from the other topics' index.
function unionTopics(entries) {
  const seen = [];
  for (const e of entries) {
    for (const t of String(e.topics || '').split(',').map(s => s.trim()).filter(Boolean)) {
      if (!seen.includes(t)) seen.push(t);
    }
  }
  return seen.join(',');
}

function generateRollupMessage(entries) {
  const category = entries[0].category;
  const topic = (entries[0].topics || 'general').split(',')[0].trim();
  // Label by quarter to match the compactor bucket key (entries in one group
  // share a quarter, not necessarily a month).
  const quarter = quarterOf(entries[0].timestamp);
  const messages = entries.map(e => e.message.replace(/^\[rollup\]\s*/i, ''));
  return `[rollup] ${category} notes on ${topic} (${quarter}): ${messages.join('; ')}.`;
}

// NOTE (P3, event-sourcing): the old pre-transaction archive helper (the one
// that wrote the per-month text + markdown side files) is DELETED, along with
// the destructive transaction it guarded. Under the inversion the append-only
// events.jsonl IS the durable record — a rolled-up/expired source entry stays
// in the log forever (its eid sits in a live supersede's rolls_up / an expire's
// target), so there is nothing to copy to a side file before "deleting" it.
// Nothing is deleted: compaction only APPENDS supersede/resolve/expire events,
// and the fold hides the originals from the live view. See executeMode below.

function regenerateMarkdown(pebblDir) {
  const db = openDb(pebblDir);
  const rows = db.prepare(`
    SELECT timestamp, source, category, tier, message, topics
    FROM logs ORDER BY timestamp ASC
  `).all();

  let md = '# Manual Logs\n\n';
  for (const row of rows) {
    const topicStr = row.topics || '';
    md += `## ${row.timestamp} - ${redact(row.message)}\n`;
    md += `<!-- cat:${row.category} topic:${topicStr} tier:${row.tier} source:${row.source} -->\n\n`;
  }

  const manualLogsPath = path.join(pebblDir, 'manual-logs.md');
  fs.writeFileSync(manualLogsPath, md);
}

function parseResolve(raw) {
  if (!raw) return new Map();
  const map = new Map();
  const VALID_ACTIONS = ['foundation', 'rollup', 'skip'];

  for (const item of raw.split(',')) {
    const parts = item.split(':');
    const id = parseInt(parts[0], 10);
    const action = parts[1];

    if (!VALID_ACTIONS.includes(action)) {
      console.error(`Invalid resolve action "${action}" for ID ${id}. Valid: foundation, rollup, skip`);
      process.exit(1);
    }

    if (map.has(id)) {
      console.error(`Duplicate resolve for ID ${id}`);
      process.exit(1);
    }

    map.set(id, action);
  }
  return map;
}

module.exports = function compact(args) {
  // --auto is a compact-only flag not in args.js's KNOWN_FLAGS (args.js is out
  // of the may-touch list). Detect it from raw args (same pattern context.js
  // uses for raw --full), then strip it before parseArgs so parseArgs doesn't
  // emit a spurious "unknown flag" warning for a flag we do support here.
  const isAuto = args.includes('--auto');
  const { flags } = parseArgs(args.filter(a => a !== '--auto'));
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  const db = openDb(pebblDir);
  const config = loadConfig(pebblDir) || {};
  const threshold = (config.compaction && config.compaction.threshold) || 10;
  const componentThreshold = (config.compaction && config.compaction.component_threshold) || 15;

  if (flags.preview) {
    return previewMode(db, threshold, componentThreshold);
  }

  // --auto: run the safe rollup unattended. resolveRaw=undefined means no
  // ambiguous (uncategorized) entries are resolved, so they are skipped — never
  // guessed. Archive-first + the SQLite transaction in executeMode are
  // unchanged, so --auto is exactly --execute minus interactive resolution.
  if (isAuto) {
    return executeMode(db, pebblDir, config, undefined);
  }

  if (flags.execute) {
    return executeMode(db, pebblDir, config, flags.resolve);
  }

  console.error('Usage: pebbl compact --preview | pebbl compact --execute [--resolve id:action,...] | pebbl compact --auto');
  process.exit(1);
};

module.exports.buildGroups = buildGroups;
module.exports.regenerateMarkdown = regenerateMarkdown;
module.exports.generateRollupMessage = generateRollupMessage;
module.exports.unionTopics = unionTopics;
module.exports.buildRowEidResolver = buildRowEidResolver;
module.exports.backfillNonEventRows = backfillNonEventRows;
module.exports.rebuildReadModelFromEvents = rebuildReadModelFromEvents;

function previewMode(db, threshold, componentThreshold) {
  const { groups, ambiguous, fleeting, protected: protectedDecisions } = buildGroups(db, threshold, componentThreshold);

  if (groups.size === 0 && ambiguous.length === 0 && fleeting.length === 0 && protectedDecisions.length === 0) {
    console.log('No entries ready for compaction.');
    return;
  }

  for (const [key, entries] of groups) {
    const [, topic, quarter] = key.split('/');
    const componentCount = entries.filter(e => e.tier === 'component').length;
    const isComponentGroup = componentCount > entries.length / 2;
    const label = isComponentGroup
      ? `[component / ${topic} / ${quarter} — ${entries.length} entries] (consolidation)`
      : `[detail / ${topic} / ${quarter} — ${entries.length} entries]`;
    console.log(label);
    for (const e of entries) {
      console.log(`  [id:${e.id}] ${e.message}`);
    }
    console.log(`  Proposed rollup: "${generateRollupMessage(entries)}"\n`);
  }

  if (ambiguous.length > 0) {
    console.log(`AMBIGUOUS — ${ambiguous.length} entries (no rubric match, need judgment):`);
    for (const e of ambiguous) {
      console.log(`  [id:${e.id}] "${e.message}"  → foundation / rollup / skip`);
    }
    console.log();
  }

  if (fleeting.length > 0) {
    console.log(`FLEETING — ${fleeting.length} entries (will be deleted on execute)\n`);
  }

  if (protectedDecisions.length > 0) {
    console.log(`PROTECTED — ${protectedDecisions.length} component decisions (KEPT, never auto-rolled — your call):`);
    for (const e of protectedDecisions) {
      console.log(`  [id:${e.id}] "${e.message}"`);
    }
    console.log();
  }

  console.log('Run: pebbl compact --execute');
  if (ambiguous.length > 0) {
    const resolveIds = ambiguous.map(e => `${e.id}:foundation`).join(',');
    console.log(`Resolve ambiguous: pebbl compact --execute --resolve ${resolveIds}`);
  }
}

function executeMode(db, pebblDir, config, resolveRaw) {
  const resolveMap = parseResolve(resolveRaw);
  const threshold = (config.compaction && config.compaction.threshold) || 10;
  const componentThreshold = (config.compaction && config.compaction.component_threshold) || 15;
  const retentionDays = (config.compaction && config.compaction.fleeting_retention) || 30;

  // Validate resolve IDs exist
  for (const [id] of resolveMap) {
    const row = db.prepare('SELECT id, category FROM logs WHERE id = ?').get(id);
    if (!row) {
      console.warn(`Warning: ID ${id} not found in database — skipping.`);
      resolveMap.delete(id);
      continue;
    }
    if (row.category !== 'uncategorized') {
      console.warn(`Warning: ID ${id} already categorized as "${row.category}" — skipping.`);
      resolveMap.delete(id);
      continue;
    }
  }

  const { groups, ambiguous, fleeting } = buildGroups(db, threshold, componentThreshold);

  // Filter fleeting by retention
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const expiredFleeting = fleeting.filter(e => (e.timestamp || '') < cutoff);

  // ── eid seam (P1 FK map, read side) ──────────────────────────────────────
  // buildGroups read db.sqlite, whose rows carry a LOCAL integer `id`. The
  // events the fold reads carry the only shared identity — the eid. To write a
  // supersede whose `rolls_up` points at the rolled-up source entries (and a
  // resolve/expire whose `target` names one), we translate each source ROW ->
  // its eid through the SAME fold that builds the read model, keyed by row
  // IDENTITY (timestamp + message), NOT by the local integer id. The old
  // positional int->eid map assumed db.sqlite's AUTOINCREMENT ids equal the
  // fold's renumbered ids; any db-only row (e.g. a pre-fix commit-capture row
  // that never got an event — see log-commit.js) shifts every later id, which
  // SILENTLY mapped rows to the wrong eid and dropped the top ids with the
  // "fold/db id drift" warning, leaving them permanently un-compactable.
  // Identity survives that drift: the (ts, message) pair is written identically
  // to both stores by every event-writing path. We still never fabricate an
  // eid: a row with no matching event (a genuinely event-less legacy/phantom
  // row) is skipped from the batch with a loud warning (the Friction the
  // contract names — escalate, don't invent).
  const resolveEid = buildRowEidResolver(pebblDir);
  const eidFor = (row, what) => {
    const eid = resolveEid(row);
    if (!eid) {
      console.warn(`Warning: no event eid for ${what} id ${row.id} (row has no matching event in events.jsonl) — skipping it from this compaction.`);
    }
    return eid || null;
  };

  // ── build the append-only batch (no row mutation) ────────────────────────
  // Every rollup group -> one supersede event (rolls_up = source eids, carrying
  // unionTopics + generateRollupMessage). Each --resolve id:foundation -> one
  // resolve event. Each --resolve id:rollup AND each expired fleeting -> one
  // expire event. These are appended together under ONE lock, then the read
  // model is rebuilt ONCE from the fold — the append-only replacement for the
  // old INSERT-rollup / DELETE-sources / UPDATE-foundation / DELETE-expired
  // transaction. db.sqlite is NEVER written here; it is REBUILT from events.
  const events = [];
  let rolledUpCount = 0;

  for (const [, entries] of groups) {
    const rolls_up = [];
    for (const e of entries) {
      const eid = eidFor(e, 'rollup source');
      if (eid) rolls_up.push(eid);
    }
    if (rolls_up.length === 0) continue; // nothing resolvable to roll up
    rolledUpCount += rolls_up.length;
    events.push(makeSupersedeEvent(pebblDir, {
      rolls_up,
      category: entries[0].category,
      tier: 'detail',
      message: generateRollupMessage(entries),
      topics: unionTopics(entries),
    }));
  }

  for (const [id, action] of resolveMap) {
    // The validate loop above guaranteed the id exists; fetch the row so the
    // identity resolver has its (timestamp, message) key.
    const row = db.prepare('SELECT id, timestamp, message FROM logs WHERE id = ?').get(id);
    const eid = eidFor(row, 'resolve target');
    if (!eid) continue;
    if (action === 'foundation') {
      events.push(makeResolveEvent(pebblDir, { target: eid, to_tier: 'foundation' }));
    } else if (action === 'rollup') {
      // "rollup" with no real group to join = drop it from the live view; the
      // append-only equivalent of the old DELETE is an expire event.
      events.push(makeExpireEvent(pebblDir, { target: eid }));
    }
    // action 'skip' never reaches here (parseResolve keeps it, executeMode's
    // resolve loop only acts on foundation/rollup — skip is a no-op by design).
  }

  for (const e of expiredFleeting) {
    const eid = eidFor(e, 'expired fleeting');
    if (eid) events.push(makeExpireEvent(pebblDir, { target: eid }));
  }

  if (events.length === 0) {
    console.log('No entries ready for compaction.');
    return;
  }

  // ONE locked batch-append + ONE rebuild. If the batch is interrupted mid-
  // write there is no transaction to roll back and none is needed: each line
  // already went through the P0 trailing-newline / torn-line invariant, so the
  // already-written events stand and the next append/fold repairs a torn final
  // line. The log is the durable record; there is nothing to "undo."
  appendEventBatch(pebblDir, events, () => {
    rebuildReadModelFromEvents(pebblDir);
  });

  const supersedeCount = events.filter(e => e.type === 'supersede').length;
  const resolveCount = events.filter(e => e.type === 'resolve').length;
  console.log(`Compacted ${rolledUpCount} detail/component entries into ${supersedeCount} rollups (append-only).`);
  if (resolveMap.size > 0) {
    const foundationCount = resolveCount;
    const rollupCount = [...resolveMap.values()].filter(a => a === 'rollup').length;
    console.log(`Resolved ${foundationCount + rollupCount} ambiguous entries (${foundationCount} foundation, ${rollupCount} rollup).`);
  }
  if (expiredFleeting.length > 0) {
    // Append-only: the originals stay in events.jsonl forever (their eid is an
    // expire event's target); the fold just hides them from the live view.
    console.log(`Expired ${expiredFleeting.length} fleeting entries (hidden, not deleted — originals remain in events.jsonl).`);
  }
  console.log('Done.');
}

// Build the row -> eid translation off the SAME fold that produces the read
// model, keyed by row IDENTITY (timestamp + message) instead of the local
// integer id. Both halves of every event-writing path stamp the SAME ts and
// message into db.sqlite and events.jsonl (log.js / log-commit.js), and no
// path ever mutates them afterwards, so the pair survives the id drift a
// db-only phantom row causes (an AUTOINCREMENT id shifts; an identity doesn't).
// Exact-duplicate rows (same ts AND message — e.g. a hook double-fire inside
// one millisecond) are handled as a MULTISET: eids queue up in fold order and
// each resolve consumes one, so two identical rows pair with two distinct
// eids deterministically. Returns resolve(row) -> eid | null.
function buildRowEidResolver(pebblDir) {
  const byIdentity = new Map(); // "ts\0message" -> [eid, ...] in fold order
  let projection;
  try {
    projection = foldFull(readEvents(pebblDir));
  } catch (err) {
    console.warn(`Warning: could not read events for eid map (${err.message}).`);
    return () => null;
  }
  for (const row of projection.logs) {
    if (!row.eid) continue;
    const key = `${row.timestamp}\u0000${row.message}`;
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(row.eid);
  }
  return (row) => {
    if (!row) return null;
    const q = byIdentity.get(`${row.timestamp}\u0000${row.message}`);
    return q && q.length > 0 ? q.shift() : null;
  };
}

// ── rebuild-preservation backfill ────────────────────────────────────────────
//
// rebuildReadModelFromEvents below OVERWRITES db.sqlite from the events fold.
// Anything in db.sqlite that never got an event is therefore DESTROYED by a
// rebuild: the commits table (the git post-commit hook wrote db-only rows
// until log-commit.js started appending `commit` events), any handoff (the
// handoff write path is still db-only), and legacy phantom logs rows. That is
// exactly how the loom store lost every captured commit in the 2026-07-12
// incident run. Before folding, mint the missing events for those rows —
// append-only, same identity resolution the compaction eid map uses
// ((timestamp, message) multiset for logs; hash multiset for commits;
// (timestamp, summary) for handoffs) — so the rebuild REGENERATES them
// instead of wiping them. Idempotent: a row whose event already exists
// consumes its identity slot and mints nothing.
//
// Boundary: only LIVE logs rows (valid_to IS NULL) are backfilled as plain
// appends — a corrected phantom row's timeline cannot be reconstructed
// without inventing a correct-chain, so it is skipped with a loud warning
// (escalate, don't invent). Phantom link fields (corrects/relates_to ints)
// are dropped for the same reason.
function backfillNonEventRows(pebblDir) {
  const dbPath = path.join(pebblDir, 'db.sqlite');
  if (!fs.existsSync(dbPath)) return { logs: 0, commits: 0, handoffs: 0 };

  const events = readEvents(pebblDir);

  // Identity multisets from the events that materialize rows.
  const logIdentity = new Map();    // "ts\0message" -> count
  const commitHashes = new Map();   // hash -> count
  const handoffIdentity = new Map(); // "ts\0summary" -> count
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'append' || e.type === 'correct' || e.type === 'supersede') {
      bump(logIdentity, `${e.ts} ${e.message || ''}`);
    } else if (e.type === 'commit') {
      bump(commitHashes, e.hash || '');
    } else if (e.type === 'handoff-open') {
      bump(handoffIdentity, `${e.ts} ${e.summary || ''}`);
    }
  }
  const consume = (map, key) => {
    const n = map.get(key) || 0;
    if (n <= 0) return false;
    map.set(key, n - 1);
    return true;
  };

  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  const minted = { logs: 0, commits: 0, handoffs: 0 };
  let skippedCorrected = 0;
  try {
    // logs: live db-only rows -> plain append events.
    let logRows = [];
    try {
      logRows = db.prepare(
        'SELECT timestamp, source, category, tier, message, topics, valid_from, valid_to FROM logs ORDER BY timestamp ASC, id ASC'
      ).all();
    } catch { /* no logs table — nothing to preserve */ }
    for (const row of logRows) {
      if (consume(logIdentity, `${row.timestamp} ${row.message}`)) continue;
      if (row.valid_to != null) { skippedCorrected += 1; continue; }
      appendEvent(pebblDir, makeAppendEvent(pebblDir, {
        ts: row.timestamp,
        category: row.category,
        tier: row.tier,
        message: row.message,
        topics: row.topics,
        source: row.source,
      }));
      minted.logs += 1;
    }

    // commits: db-only capture rows -> commit events (hash is the identity).
    let commitRows = [];
    try {
      commitRows = db.prepare(
        'SELECT timestamp, hash, message, files FROM commits ORDER BY timestamp ASC, id ASC'
      ).all();
    } catch { /* no commits table */ }
    for (const row of commitRows) {
      if (consume(commitHashes, row.hash)) continue;
      appendEvent(pebblDir, makeCommitEvent(pebblDir, {
        ts: row.timestamp,
        hash: row.hash,
        message: row.message,
        files: row.files,
      }));
      minted.commits += 1;
    }

    // handoffs: db-only rows -> handoff-open (+ handoff-close when closed).
    // session_entries/session_commits are convenience back-links; the int/hash
    // arrays are carried VERBATIM only where the fold can survive them —
    // session_entries ints cannot resolve to eids here (the fold drops
    // unresolvable refs), so they are dropped like migrate --repair drops a
    // dangling element. Summary/done/todo/blocked/topics/docs are lossless.
    let handoffRows = [];
    try {
      handoffRows = db.prepare(
        'SELECT timestamp, summary, done, todo, blocked, topics, source, session_commits, status, closed_at, docs FROM handoffs ORDER BY id ASC'
      ).all();
    } catch { /* no handoffs table */ }
    for (const row of handoffRows) {
      if (consume(handoffIdentity, `${row.timestamp} ${row.summary}`)) continue;
      let sessionCommits = [];
      try {
        const parsed = JSON.parse(row.session_commits || '[]');
        if (Array.isArray(parsed)) sessionCommits = parsed;
      } catch { /* malformed back-link array — drop, the handoff text survives */ }
      const open = {
        ...makeEnvelope(pebblDir, 'handoff-open', { ts: row.timestamp }),
        summary: row.summary || '',
        done: row.done || null,
        todo: row.todo || null,
        blocked: row.blocked || null,
        topics: row.topics || null,
        source: row.source || 'agent',
        session_entries: [],
        session_commits: sessionCommits,
        docs: row.docs || null,
      };
      appendEvent(pebblDir, open);
      if (String(row.status) === 'closed') {
        appendEvent(pebblDir, {
          ...makeEnvelope(pebblDir, 'handoff-close', { ts: row.closed_at || row.timestamp }),
          handoff: open.eid,
        });
      }
      minted.handoffs += 1;
    }
  } finally {
    db.close();
  }

  if (minted.logs + minted.commits + minted.handoffs > 0) {
    console.warn(
      `pebbl: backfilled ${minted.commits} commit(s), ${minted.logs} log row(s), ${minted.handoffs} handoff(s) ` +
      'into events.jsonl (db-only rows with no event — preserved across the rebuild).'
    );
  }
  if (skippedCorrected > 0) {
    console.warn(
      `Warning: ${skippedCorrected} superseded db-only log row(s) had no event and were NOT backfilled ` +
      '(a corrected phantom cannot be reconstructed append-only); their history remains in the pre-rebuild markdown.'
    );
  }
  return minted;
}

// Rebuild the read model from events.jsonl after a compaction batch is
// appended. The fold hides rolled-up / resolved / expired entries (their eids
// sit in a live supersede's rolls_up or an expire's target) and surfaces the
// rollup row, so the regenerated view reflects the compaction WITHOUT any row
// being deleted from the log. We rewrite db.sqlite (still the canonical read
// path pre-P6-cutover) and the markdown projections + the disposable
// view.sqlite from the one folded projection, so `pebbl context` / search see
// the compacted state. db.sqlite is a REBUILT index here, never edited in place
// — the destructive INSERT/DELETE/UPDATE is gone.
//
// PRESERVATION: the backfill above runs FIRST, so any db-only capture rows
// (commits, handoffs, live phantom logs) are minted into events.jsonl before
// the fold that regenerates db.sqlite — a rebuild can no longer destroy
// rows that were never event-backed. Caller must hold the store lock
// (every caller reaches here inside appendEventBatch's withLock).
function rebuildReadModelFromEvents(pebblDir) {
  backfillNonEventRows(pebblDir);
  const projection = foldFull(readEvents(pebblDir));

  // Markdown projections (browsing surfaces) from the byte-identical emitters.
  fs.writeFileSync(path.join(pebblDir, 'manual-logs.md'), renderManualLogsMd(projection.logs));
  fs.writeFileSync(path.join(pebblDir, 'handoffs.md'), renderHandoffsMd(projection.handoffs));
  const narrativeMd = renderNarrativeMd(projection.narrative);
  if (narrativeMd) fs.writeFileSync(path.join(pebblDir, 'narrative.md'), narrativeMd);
  fs.writeFileSync(path.join(pebblDir, 'commit-log.md'), renderCommitLogMd(projection.commits));

  // The disposable view.sqlite (P1 artifact) + the canonical db.sqlite read
  // path, both rebuilt from the SAME projection so the live read sees the
  // rollup. writeViewSqlite drops + recreates each file from the folded rows.
  writeViewSqlite(projection, path.join(pebblDir, 'view.sqlite'));
  writeViewSqlite(projection, path.join(pebblDir, 'db.sqlite'));

  // writeViewSqlite writes the CURRENT read contract (the post-v0.7 shape:
  // rerank columns present, importance tier-derived) but no schema_version
  // row. The canonical read path opens db.sqlite through openDb -> migrate(),
  // which keys off meta.schema_version, so a rebuilt store must land at the
  // CURRENT version — a stale stamp makes the next read re-run (and
  // re-announce) every migration above it on EVERY post-rebuild read (the
  // "migrated db to v0.6/v0.7" noise after each compaction). Stamp the 0.5
  // floor (the last shape this rebuild guaranteed before the rerank columns),
  // then run the real migration chain ONCE, quietly, here inside the rebuild.
  // Running the chain instead of hardcoding the current number keeps this
  // self-maintaining: a future v0.8 data backfill runs here too, and the
  // stamp can never drift below what migrate() considers current (DRY — one
  // place owns "current").
  const { migrate } = require('./migrate');
  const Database = require('better-sqlite3');
  const cdb = new Database(path.join(pebblDir, 'db.sqlite'));
  try {
    cdb.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    cdb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run('0.5');
    migrate(cdb, { quiet: true });
  } finally {
    cdb.close();
  }
}
