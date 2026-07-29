'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb, openReadDb, topicFilter, validAsOf, notCorrected, recordAccess } = require('./db');
const { storeMode } = require('./store-mode');
const { rankCandidates } = require('./rank');
const { buildGroups } = require('./compact');
const { loadConfig, ensureProjectFiles } = require('./rubric');
const { displayEntry } = require('./log');
const { isThinEntry } = require('./detect-thin');
const { readNarrative, readRefs, readUpdatedTimestamp, updateRefs } = require('./narrative');
const { mirrorMachines, mirrorLogs, mirrorHandoffs, stripHandoffPrefix } = require('./mirror');

// ── helpers ──────────────────────────────────────────────────────────────────

// Record the usage signal against the CANONICAL db.sqlite. The read handle may
// be the readonly view.sqlite (events-mode reads-from-fold), which can't take
// the write — and the view is rebuilt from events on every fold, so a write
// there would be lost anyway. So: in events-mode open db.sqlite just for this
// increment and close it; in legacy mode reuse the read handle (it already IS
// db.sqlite). Best-effort: recordAccess is itself try-caught + a no-op under the
// test guard, and we never let a usage write break the read it rode in on.
function recordAccessCanonical(pebblDir, readDb, ids) {
  if (storeMode(pebblDir) === 'events') {
    let wdb;
    try {
      wdb = openDb(pebblDir);
      recordAccess(wdb, ids);
    } catch {
      // never let the usage signal break the read
    } finally {
      if (wdb) { try { wdb.close(); } catch { /* ignore */ } }
    }
  } else {
    recordAccess(readDb, ids);
  }
}

function findRelatedCommits(cwd, message) {
  try {
    const { execSync } = require('child_process');
    const gitDir = path.join(cwd, '.git');
    if (!fs.existsSync(gitDir)) return [];

    const output = execSync('git log --format="%h %s" -50', { cwd, encoding: 'utf8' });
    const lines = output.trim().split('\n').filter(Boolean);

    const stopWords = new Set([
      'this', 'that', 'with', 'from', 'have', 'been', 'were', 'they', 'will',
      'would', 'could', 'should', 'which', 'their', 'about', 'into', 'over',
      'after', 'before', 'between', 'under', 'also', 'other', 'some', 'such',
      'only', 'then', 'than', 'like', 'just', 'much', 'more', 'most', 'very',
      'when', 'what', 'where', 'there', 'here', 'does',
    ]);

    const words = message.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));

    const uniqueWords = [...new Set(words)];
    if (uniqueWords.length === 0) return [];

    const scored = lines.map(line => {
      const spaceIdx = line.indexOf(' ');
      const hash = line.slice(0, spaceIdx);
      const msg = line.slice(spaceIdx + 1).toLowerCase();
      const score = uniqueWords.filter(w => msg.includes(w)).length;
      return { hash, message: line.slice(spaceIdx + 1), score };
    }).filter(c => c.score >= 2)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, 2);
  } catch {
    return [];
  }
}

function relativeDate(isoTimestamp) {
  if (!isoTimestamp) return '';
  const d = new Date(isoTimestamp);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getNarrativeUpdated(pebblDir) {
  try {
    const narrativePath = path.join(pebblDir, 'narrative.md');
    const content = fs.readFileSync(narrativePath, 'utf8');
    const match = content.match(/<!--\s*updated:\s*(\S+)/);
    if (match) return match[1];
  } catch {}
  return null;
}

// ── shared UI ────────────────────────────────────────────────────────────────

// Whole hours since an ISO timestamp, as a short label. Hour-granularity (the
// open-handoff staleness signal needs sub-day resolution); relativeDate above
// is day-granularity and used for the closed-handoff/topic dates, so the two
// coexist intentionally.
function hoursAgo(isoTimestamp) {
  return Math.round((Date.now() - new Date(isoTimestamp).getTime()) / 3600000);
}
function hoursAgoText(isoTimestamp) {
  const ago = hoursAgo(isoTimestamp);
  return ago < 1 ? 'just now' : `${ago}h ago`;
}

function showOpenHandoff(db, pebblDir) {
  const hasHandoffsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoffs'").get();
  if (!hasHandoffsTable) return;

  // The handoffs table permits unlimited open rows and creating a handoff never
  // closes priors, so opens stack. Fetch ALL of them (newest first) rather than
  // a single LIMIT 1 slot that buries older opens with no count or signal.
  const opens = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC").all();
  if (opens.length === 0) return;

  const config = loadConfig(pebblDir) || {};
  const staleHours = (config.handoff && config.handoff.staleHours) || 48;

  // Render the newest open in full — that is "today's" working handoff.
  const newest = opens[0];
  console.log(`── Open handoff from previous agent (#${newest.id}, ${hoursAgoText(newest.timestamp)}) ──`);
  console.log(newest.summary);
  if (newest.done)    console.log(`  previous agent completed: ${newest.done}`);
  if (newest.todo)    console.log(`  remaining for you:        ${newest.todo}`);
  if (newest.blocked) console.log(`  blocked:                  ${newest.blocked}`);
  if (newest.topics)  console.log(`  topics:                   ${newest.topics}`);
  // Resurface the rendered handoff doc(s) so the readable detail is never orphaned —
  // the whole point of linking one is that the NEXT agent finds it on pickup.
  if (newest.docs) {
    const docList = JSON.parse(newest.docs || '[]');
    if (docList.length) {
      console.log(`  📄 full detail:           ${docList.join(', ')} — read this first`);
    }
  }
  if (hoursAgo(newest.timestamp) >= staleHours) {
    console.log(`  ⚠ stale: open ${hoursAgo(newest.timestamp)}h (≥ ${staleHours}h threshold)`);
  }
  console.log('  → when you finish the remaining work, run: pebbl handoff --close');

  // One-line rollup for the rest, so stacked opens are visible and drainable.
  if (opens.length > 1) {
    const oldest = opens[opens.length - 1];
    console.log(
      `  ⚠ ${opens.length} open handoffs (oldest #${oldest.id}, ${hoursAgo(oldest.timestamp)}h ago) ` +
      `— run pebbl handoff --list-open`
    );
    const stale = opens.filter(h => hoursAgo(h.timestamp) >= staleHours);
    if (stale.length > 0) {
      const ids = stale.map(h => `#${h.id}`).join(', ');
      console.log(`  ⚠ ${stale.length} stale (≥ ${staleHours}h): ${ids}`);
    }
  }
  console.log('──');
  console.log('');
}

function showRecentHandoffs(db) {
  const hasHandoffsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoffs'").get();
  if (!hasHandoffsTable) return;

  const rows = db.prepare(
    "SELECT * FROM handoffs WHERE status = 'closed' ORDER BY id DESC LIMIT 3"
  ).all();
  if (rows.length === 0) return;

  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

  console.log('--- RECENT HANDOFFS ---');
  for (const row of rows) {
    const date = relativeDate(row.closed_at || row.timestamp);
    console.log(`  #${row.id} (${date}) ${trunc(row.summary, 90)}`);
    const todos = (row.todo || '').split(';').map(s => s.trim()).filter(Boolean);
    todos.slice(0, 2).forEach(t => console.log(`    todo: ${trunc(t, 90)}`));
    if (todos.length > 2) console.log(`    … +${todos.length - 2} more todo (pebbl handoff --latest)`);
  }
  console.log('');
}

function showEntryWithThinCheck(row, cwd) {
  console.log(displayEntry(row));
  const msg = row.message || '';
  if (isThinEntry(msg)) {
    const commits = findRelatedCommits(cwd, msg);
    for (const c of commits) {
      console.log(`  └─ git: ${c.hash} ${c.message}`);
    }
    if (commits.length > 0) {
      console.log('  ⚠ no explicit rationale found — commit shows implementation detail, not decision reasoning');
    } else {
      console.log('  ⚠ no explicit rationale found — consider correcting with: pebbl log "because..." --corrects ' + row.id);
    }
  }
}

// Other machines' synced memory (.pebbl/mirror/<machine>/). Prints nothing
// when no mirrors exist, so output is unchanged until the sync jobs create
// them. Read-only: mirrors regenerate from the other machine's db.
function showMirrors(pebblDir) {
  for (const machine of mirrorMachines(pebblDir)) {
    const opens = mirrorHandoffs(pebblDir, machine)
      .filter(h => h.status === 'open' && h.field === 'summary')
      .slice(0, 3);
    const logs = mirrorLogs(pebblDir, machine).slice(0, 5);
    if (opens.length === 0 && logs.length === 0) continue;

    console.log(`--- MIRROR: ${machine} ---`);
    for (const h of opens) {
      console.log(`  open handoff: ${stripHandoffPrefix(h.message)}`);
    }
    for (const e of logs) {
      console.log('  ' + displayEntry({
        tier: e.tier, category: e.cat, timestamp: e.timestamp,
        message: e.message, topics: e.topics,
      }));
    }
    console.log('');
  }
}

// The nag must report ONLY what `pebbl compact --preview` would actually roll
// up — one source of truth. The old query counted a flat per-topic population
// (no category, no quarter bucket, no component_threshold, no corrected-entry
// exclusion), so it promised compaction the executor could never deliver and
// fired forever. Now it calls the same buildGroups() the executor uses: every
// reported group has already passed its effective threshold (component groups
// need component_threshold, default 15), so the count is honest.
function showCompactionNotifications(db, pebblDir) {
  const config = loadConfig(pebblDir) || {};
  const threshold = (config.compaction && config.compaction.threshold) || 10;
  const componentThreshold = (config.compaction && config.compaction.component_threshold) || 15;

  const { groups } = buildGroups(db, threshold, componentThreshold);

  for (const [key, entries] of groups) {
    const topic = key.split('/')[1];
    console.log(`[pebbl] ${entries.length} entries on '${topic}' ready for compaction. Run: pebbl compact --preview`);
  }

  // Compaction-on-release: a SOFT reminder only (design Q2=A). Now that
  // compaction is append-only, it is the natural thing to run before sharing /
  // releasing a store so the rollups are in the committed log. This is a
  // notification, NEVER an interlock — it does not block, error, or change the
  // exit code. The fold dedups overlapping rollups, so skipping it is "ugly,
  // not broken." Harden later only if duplicate rollups appear in practice.
  if (groups.size > 0) {
    console.log('[pebbl] tip: compaction is append-only now — consider running it before you release/share this store.');
  }
}

// ── drift detection ──────────────────────────────────────────────────────────

function checkDrift(pebblDir, db) {
  const refs = readRefs(pebblDir);
  const updatedTs = readUpdatedTimestamp(pebblDir);
  if (!updatedTs) return { drift: 0, reasons: [] };

  const reasons = [];

  // Check for new foundation entries since narrative was updated
  const newFoundation = db.prepare(
    "SELECT COUNT(*) as cnt FROM logs WHERE tier = 'foundation' AND timestamp > ?"
  ).get(updatedTs);
  if (newFoundation && newFoundation.cnt > 0) {
    reasons.push(`${newFoundation.cnt} new foundation decisions since last update`);
  }

  // Check for corrections to referenced entries
  if (refs.length > 0) {
    const placeholders = refs.map(() => '?').join(',');
    const corrected = db.prepare(
      `SELECT COUNT(*) as cnt FROM logs WHERE corrects IN (${placeholders}) AND timestamp > ?`
    ).get(...refs, updatedTs);
    if (corrected && corrected.cnt > 0) {
      reasons.push(`${corrected.cnt} referenced decisions have been corrected`);
    }
  }

  return { drift: reasons.length, reasons };
}

// ── mode: default (new 3-section format) ────────────────────────────────────

function contextDefault(pebblDir, db) {
  const cwd = process.cwd();

  showOpenHandoff(db, pebblDir);

  // ── Section 1: NARRATIVE ──

  const narrative = readNarrative(pebblDir);
  if (narrative) {
    const narrUpdated = getNarrativeUpdated(pebblDir);
    const dateStr = narrUpdated ? relativeDate(narrUpdated) : '';
    // Strip HTML comments and the # Project Narrative heading for cleaner display
    const cleaned = narrative
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^# Project Narrative\n*/m, '')
      .trim();
    console.log('--- NARRATIVE ---');
    console.log(cleaned);
    if (dateStr) console.log(`(updated: ${dateStr})`);

    // Check for drift
    const driftResult = checkDrift(pebblDir, db);
    if (driftResult.drift > 0) {
      // Auto-update refs if corrections were made
      updateRefs(pebblDir, db);
      console.log(`[pebbl] Narrative may be outdated: ${driftResult.reasons.join('; ')}`);
      console.log('  Update the text: pebbl narrative "<updated text>"');
    }

    console.log('');
  } else {
    console.log('hint: no project narrative set. Run: pebbl narrative "..."');
    console.log('');
  }

  // ── Section 2: TOPIC INDEX ──

  // Query: non-fleeting entries by topic+tier, excluding corrected entries
  const topicRows = db.prepare(`
    SELECT topics, tier, COUNT(*) as cnt, MAX(timestamp) as last_updated
    FROM logs
    WHERE tier IN ('foundation', 'component')
      AND topics IS NOT NULL AND topics != ''
      AND ${notCorrected()}
    GROUP BY topics, tier
    ORDER BY last_updated DESC
  `).all();

  // Aggregate by topic — split comma-separated topics and count per-tier
  const topicMap = new Map();
  for (const row of topicRows) {
    const topicList = row.topics.split(',').map(t => t.trim()).filter(Boolean);
    for (const t of topicList) {
      if (!topicMap.has(t)) {
        topicMap.set(t, { maxTs: null, foundation: 0, component: 0 });
      }
      const entry = topicMap.get(t);
      if (row.tier === 'foundation') entry.foundation += row.cnt;
      if (row.tier === 'component') entry.component += row.cnt;
      if (!entry.maxTs || row.last_updated > entry.maxTs) {
        entry.maxTs = row.last_updated;
      }
    }
  }

  // Sort by most recently updated
  const sortedTopics = [...topicMap.entries()].sort((a, b) => {
    const aTs = a[1].maxTs || '';
    const bTs = b[1].maxTs || '';
    return bTs.localeCompare(aTs);
  });

  if (sortedTopics.length > 0) {
    const totalAreas = sortedTopics.length;
    const totalDecisions = sortedTopics.reduce((sum, [, v]) => sum + v.foundation + v.component, 0);
    console.log(`--- TOPICS (${totalAreas} areas, ${totalDecisions} decisions) ---`);
    for (const [topic, data] of sortedTopics) {
      const parts = [];
      if (data.foundation > 0) parts.push(`${data.foundation} foundation`);
      if (data.component > 0) parts.push(`${data.component} component`);
      const dateStr = data.maxTs ? relativeDate(data.maxTs) : '';
      console.log(`  ${topic.padEnd(14)}${parts.join(', ')} decisions (updated ${dateStr})`);
    }
    console.log('');
  } else {
    console.log('--- TOPICS ---');
    console.log('  (no topics yet)');
    console.log('');
  }

  // ── Section 3: RECENT ACTIVITY ──
  //
  // Ordering CHANGED (v0.7): rerank rankCandidates replaces the old `id DESC`
  // (newest-first) cut. This is the live read-path wiring — what an entry IS
  // (importance/usage/recency) now decides what surfaces here, not just when it
  // was written. The current-belief filter (valid_to IS NULL, via notCorrected)
  // and the non-fleeting tier set are kept; rerank only reorders the same
  // candidate set. Section keeps the --- RECENT --- label (it is still the
  // "what should I look at" section) even though it is no longer strictly
  // newest-first. relevance is flat/0 here (context does no relevance ranking), as expected.
  const recentCandidates = db.prepare(`
    SELECT id, timestamp, source, category, tier, message, topics,
           importance, access_count, last_accessed
    FROM logs
    WHERE tier IN ('foundation', 'component', 'detail')
      AND ${notCorrected()}
  `).all();
  const recentRows = rankCandidates(recentCandidates).slice(0, 5);

  console.log('--- RECENT ---');
  if (recentRows.length === 0) {
    console.log('  (no entries yet)');
  } else {
    for (const row of recentRows) {
      showEntryWithThinCheck(row, cwd);
    }
  }
  console.log('---');
  console.log('');

  // NO recordAccess here (FIX 1). The default `pebbl context` dump is a broad
  // session-start render — printing the top-5 RECENT slate is NOT the user
  // intentionally looking an entry up. Counting it would make access_count track
  // how often an entry was PRINTED (a rich-get-richer print-frequency loop), not
  // how often it was genuinely retrieved, polluting the very usage signal rerank
  // reads. rerank ORDERING still applies to this read (ordering by current usage
  // is fine); only the increment WRITE is gated to intentional lookups.
  showRecentHandoffs(db);

  showMirrors(pebblDir);

  showCompactionNotifications(db, pebblDir);
}

// ── mode: full (legacy flat list, activated via --full) ─────────────────────

function contextFull(pebblDir, db, flags) {
  const cwd = process.cwd();

  showOpenHandoff(db, pebblDir);

  let sql = `SELECT id, timestamp, source, category, tier, message, topics,
                    importance, access_count, last_accessed
             FROM logs WHERE ${notCorrected()} AND 1=1`;
  const params = [];

  if (flags.cat) {
    sql += ' AND category = ?';
    params.push(flags.cat);
  }
  if (flags.tier) {
    sql += ' AND tier = ?';
    params.push(flags.tier);
  }
  if (flags.source) {
    sql += ' AND source = ?';
    params.push(flags.source);
  }
  if (flags.topic) {
    const filter = topicFilter(flags.topic);
    sql += ' ' + filter.clause;
    params.push(...filter.params);
  }

  // Ordering CHANGED (v0.7): the old tier-then-id (CASE tier..., id DESC) cut is
  // replaced by rerank rankCandidates over the filtered current-belief set. The
  // WHERE filters (current belief + cat/tier/source/topic) are unchanged; rerank
  // only reorders, then we take the same top 10.
  const candidates = db.prepare(sql).all(...params);
  const rows = rankCandidates(candidates).slice(0, 10);

  console.log('--- PROJECT MEMORY ---');
  if (rows.length === 0) {
    console.log('(no entries yet)');
  } else {
    for (const row of rows) {
      showEntryWithThinCheck(row, cwd);
    }
  }
  console.log('---');

  // NO recordAccess here (FIX 1). --full is a broad memory dump (up to 10 rows,
  // optionally filtered), the session-start "show me everything" view — not a
  // targeted retrieval of a specific entry. Counting it would inflate access_count
  // by print frequency. rerank still reorders this read; only the increment is
  // gated to intentional lookups (contextTopic).
  showCompactionNotifications(db, pebblDir);
}

// ── mode: topic-scoped (activated via --topic) ─────────────────────────────

function contextTopic(pebblDir, db, topic, flags) {
  const cwd = process.cwd();

  showOpenHandoff(db, pebblDir);

  const filter = topicFilter(topic);
  const COLS = `id, timestamp, source, category, tier, message, topics,
                importance, access_count, last_accessed`;

  // 1. ALL foundation entries (regardless of topic)
  let sql = `SELECT ${COLS} FROM logs WHERE tier = 'foundation' AND ${notCorrected()}`;
  const fParams = [];
  if (flags.cat) { sql += ' AND category = ?'; fParams.push(flags.cat); }
  const foundationRows = db.prepare(sql).all(...fParams);

  // 2. ALL component entries matching the topic
  sql = `SELECT ${COLS} FROM logs WHERE tier = 'component' AND ${notCorrected()} ${filter.clause}`;
  const cParams = [...filter.params];
  if (flags.cat) { sql += ' AND category = ?'; cParams.push(flags.cat); }
  const componentRows = db.prepare(sql).all(...cParams);

  // 3. Recent detail entries matching the topic (limit 5). The SELECTION of
  // which details to consider stays recency-based (newest 5) — that is a
  // candidate-set policy, not the final display order — so the id DESC LIMIT 5
  // is kept here intentionally.
  sql = `SELECT ${COLS} FROM logs WHERE tier = 'detail' AND ${notCorrected()} ${filter.clause}`;
  const dParams = [...filter.params];
  if (flags.cat) { sql += ' AND category = ?'; dParams.push(flags.cat); }
  sql += ' ORDER BY id DESC LIMIT 5';
  const detailRows = db.prepare(sql).all(...dParams);

  // Ordering CHANGED (v0.7): the combined slate was sorted tier-then-id (newest
  // first within each tier); it is now ordered by rerank rankCandidates over the
  // same combined candidate set (all foundation + on-topic component + 5 newest
  // on-topic detail). The current-belief filter is unchanged on every fetch.
  const allRows = rankCandidates([...foundationRows, ...componentRows, ...detailRows]);

  console.log(`--- TOPIC: ${topic} ---`);
  if (allRows.length === 0) {
    console.log('(no entries)');
  } else {
    for (const row of allRows) {
      showEntryWithThinCheck(row, cwd);
    }
  }
  console.log('---');

  // recordAccess fires HERE (FIX 1): `pebbl context --topic <x>` is the targeted
  // retrieval path — the user asking "what do we know about X" and getting the
  // entries on that topic. THIS is an intentional lookup, so counting it makes
  // access_count mean "how often this entry was deliberately looked up" rather
  // than "how often it was printed in a dump". Guarded (no-op under the test
  // suite via NODE_TEST_CONTEXT) and deduped inside recordAccess.
  //
  // The usage signal is per-machine and lives in the CANONICAL db.sqlite. In
  // events-mode the read `db` above is the READONLY view.sqlite (reads-from-
  // fold), so we open the canonical store JUST for this write; in legacy mode
  // `db` already IS db.sqlite, so reuse it (one fewer open). The view's row ids
  // are the fold's local ints, the SAME ints db.sqlite carries for the same
  // entries — db.sqlite is itself folded from the same events on every write
  // (log.js appendLogEvent), one eid->int map — so an id gathered off the view
  // updates the right db.sqlite row. recordAccess is best-effort + try-caught,
  // so even a stale/missing target can never break the read.
  recordAccessCanonical(pebblDir, db, allRows.map(r => r.id));

  showCompactionNotifications(db, pebblDir);
}

// ── mode: as-of (bi-temporal point-in-time, activated via --as-of) ──────────
//
// Memory as it was BELIEVED on a given date. Unlike the default/topic/full
// views (which show only valid_to IS NULL — the current belief), this returns
// the rows whose validity interval covers <date>: started on/before it and not
// yet superseded as of it. This is how the timeline survives a correction —
// the superseded belief reappears when you ask about a date before it stopped.
function contextAsOf(pebblDir, db, date, flags) {
  const cwd = process.cwd();
  let sql = `SELECT id, timestamp, source, category, tier, message, topics
             FROM logs
             WHERE ${validAsOf()}`;
  const params = [date, date];

  if (flags.cat)    { sql += ' AND category = ?'; params.push(flags.cat); }
  if (flags.tier)   { sql += ' AND tier = ?';     params.push(flags.tier); }
  if (flags.source) { sql += ' AND source = ?';   params.push(flags.source); }
  if (flags.topic) {
    const filter = topicFilter(flags.topic);
    sql += ' ' + filter.clause;
    params.push(...filter.params);
  }
  sql += ` ORDER BY CASE tier WHEN 'foundation' THEN 0 WHEN 'component' THEN 1 WHEN 'detail' THEN 2 WHEN 'fleeting' THEN 3 ELSE 4 END, id DESC LIMIT 20`;

  const rows = db.prepare(sql).all(...params);

  // NOTE: as-of is a bitemporal TIME-TRAVEL view (validAsOf, not the current-
  // belief filter) — it deliberately shows beliefs as they stood on <date>,
  // including ones since superseded. It is NOT a current-belief read, so it
  // keeps its tier-then-id ordering (rerank is wired only into the current-
  // belief reads per this slice) and does NOT increment access_count (counting a
  // historical reconstruction would distort the live usage signal).
  console.log(`--- MEMORY AS OF ${date} ---`);
  if (rows.length === 0) {
    console.log('(nothing was believed as of that date)');
  } else {
    for (const row of rows) {
      showEntryWithThinCheck(row, cwd);
    }
  }
  console.log('---');
}

// ── exported entry point ─────────────────────────────────────────────────────

module.exports = function context(args) {
  const { flags } = parseArgs(args);
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  // Wire 2 — reads-from-fold: in an events-mode store this opens the folded
  // view.sqlite (so a pulled/merged events.jsonl is what gets read); in a legacy
  // store it is exactly openDb(db.sqlite). All the contextDefault/Full/Topic/
  // AsOf queries run unchanged against whichever handle this returns — the view
  // carries the same schema + read contract (current-belief filter, rerank
  // columns) as the migrated db.
  const db = openReadDb(pebblDir);

  // Check raw args for --full since it is not in KNOWN_FLAGS
  const isFull = args.includes('--full');

  if (flags['as-of']) {
    contextAsOf(pebblDir, db, flags['as-of'], flags);
  } else if (isFull) {
    contextFull(pebblDir, db, flags);
  } else if (flags.topic) {
    contextTopic(pebblDir, db, flags.topic, flags);
  } else if (flags.cat || flags.tier || flags.source) {
    // Filter flags without --topic or --full fall through to full view
    // for backward compatibility
    contextFull(pebblDir, db, flags);
  } else {
    contextDefault(pebblDir, db);
  }

  // Search-first nudge: context shows the curated index, but superseded or
  // corrected decisions that grep can't surface live in the search corpus.
  console.log("before deciding in an area you don't see above, run pebbl search '<area>' — catches superseded choices grep can't");
};
