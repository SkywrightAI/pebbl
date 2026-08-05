'use strict';
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openReadDb, topicFilter, notCorrected, fts5Available, buildFtsIndex, FTS_TABLE } = require('./db');
const { storeMode } = require('./store-mode');
const { displayEntry } = require('./log');
const { ensureProjectFiles, loadConfig } = require('./rubric');
const { splitItems } = require('./handoff');
const { mirrorLogs, mirrorHandoffs } = require('./mirror');
const { searchSources } = require('./sources');

// Normalize a message for near-duplicate comparison.
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Split a query into lowercased whitespace-delimited terms for the SQLite
// fallback. The fallback used to LIKE the whole query as one string, so a
// multi-word search ("invite code") only matched docs containing that exact
// adjacent phrase and missed almost everything. Tokenizing into AND-of-terms
// makes each term a separate filter, recovering recall when the words are
// scattered. An empty/blank query yields [] (callers treat that as "match all").
function queryTerms(query) {
  return (query || '').toLowerCase().split(/\s+/).filter(Boolean);
}

// ── curated synonym map (JUSTIFY-NEW) ────────────────────────────────────────
//
// There is no synonym source in the repo, so this is the one net-new artifact.
// It is deliberately TINY and obviously extensible: a flat list of equivalence
// GROUPS. Each group's words are treated as interchangeable, so a search for any
// member also matches an entry that contains only another member (e.g. searching
// "cancel" finds an entry that says "terminate"). Expansion happens BEFORE the
// FTS5 MATCH as an OR-group per query term (see buildMatchQuery), so it costs
// nothing on the index side and never touches stored data.
//
// Kept intentionally small — these are real, high-value pebbl/engineering pairs,
// not a thesaurus. Porter stemming already collapses inflections (reject/rejected,
// deploy/deploys), so this map only needs DISTINCT lemmas, not word forms. Add a
// group by appending an array; SYNONYM_INDEX is derived from it so there is one
// source of truth.
const SYNONYM_GROUPS = [
  ['cancel', 'terminate', 'abort'],
  ['deploy', 'ship', 'release'],
  ['bug', 'defect', 'issue'],
  ['delete', 'remove'],
  ['fix', 'patch'],
];

// term -> [synonyms] (the term itself excluded), built once from the groups so
// the map above stays the single place to edit. A term in two groups gets the
// union of both groups' members.
const SYNONYM_INDEX = (() => {
  const idx = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      const others = group.filter((w) => w !== word);
      const prev = idx.get(word) || [];
      for (const o of others) if (!prev.includes(o)) prev.push(o);
      idx.set(word, prev);
    }
  }
  return idx;
})();

// FTS5 bareword grammar is picky: a term containing anything outside its token
// charset (or a bareword that collides with a keyword like AND/OR/NOT/NEAR) is a
// syntax error. Wrapping each term as a double-quoted FTS5 string makes it a
// literal — quotes are escaped by doubling per the FTS5 string rules — so an
// arbitrary user term can never produce a malformed MATCH. A trailing '*' (set by
// the caller for the last token) is appended OUTSIDE the quotes so it stays a
// prefix operator rather than a literal asterisk.
function ftsQuote(term, prefix) {
  const quoted = '"' + String(term).replace(/"/g, '""') + '"';
  return prefix ? quoted + ' *' : quoted;
}

// Build the FTS5 MATCH expression from a query, AND-ing the terms (every term
// must match, same recall semantics as the LIKE fallback's AND-of-terms) while
// OR-expanding each term against its curated synonyms. Reuses queryTerms() as
// the ONE tokenizer so FTS and the fallback agree on what a "term" is.
//
//   "cancel deploy"  ->  ("cancel" OR "terminate" OR "abort") AND ("deploy" OR "ship" OR "release")
//
// The final token also gets a prefix form ("auth" -> ("auth" OR auth*)) so a
// partial last word still matches as the user types — phrase/prefix support
// without a separate code path. Returns '' for a blank query (caller treats that
// as "no FTS constraint").
function buildMatchQuery(query) {
  const terms = queryTerms(query);
  if (terms.length === 0) return '';
  return terms
    .map((term, i) => {
      const isLast = i === terms.length - 1;
      const alts = [ftsQuote(term, false)];
      // Prefix-match the last token so a half-typed word still hits.
      if (isLast && term.length >= 2) alts.push(ftsQuote(term, true));
      for (const syn of SYNONYM_INDEX.get(term) || []) alts.push(ftsQuote(syn, false));
      return alts.length === 1 ? alts[0] : `(${alts.join(' OR ')})`;
    })
    .join(' AND ');
}

// True when every term in `terms` appears (substring) in `text`. AND semantics,
// matching the SQL we build below; an empty term list matches everything.
function matchesAllTerms(text, terms) {
  const t = (text || '').toLowerCase();
  return terms.every(term => t.includes(term));
}

// Strip the deterministic "handoff #N field: " prefix from a materialized item.
function stripHandoffPrefix(message) {
  const m = message.match(/^handoff #\d+ (?:summary|done|todo|blocked): (.+)$/i);
  return m ? m[1] : message.replace(/^handoff #\d+: /i, '');
}

// Render a structured result object to a display line. Results read from
// another machine's mirror carry r.machine and get a leading [machine] tag.
function formatResult(r) {
  // Source-doc discovery hits: external truth, tagged [source], no machine/topics.
  if (r.isSource) return `[source] ${r.source} — ${r.message}`;
  // Compacted/archived history, surfaced only under --include-archive, tagged
  // and ranked lowest so it never re-bloats live results.
  if (r.tier === 'archived') return `[archived] [${r.cat}] ${r.date} — ${r.message}`;
  let out;
  if (r.isHandoff) {
    const open = r.status === 'open' ? ' · OPEN' : '';
    out = `[handoff #${r.handoffId}${open} · ${r.field}] ${r.date} — ${stripHandoffPrefix(r.message)}`;
  } else {
    // `#id` leads the line so it can be copied straight into --relates/--corrects.
    // Guarded: mirror hits come from another machine's projection and carry no
    // local id (and that id would be meaningless here anyway).
    const ref = r.id != null ? `#${r.id} ` : '';
    out = `${ref}[${r.tier}|${r.cat}] ${r.date} — ${r.message}`;
  }
  if (r.machine) out = `[${r.machine}] ` + out;
  if (r.topics) out += `\n  topics: ${r.topics}`;
  return out;
}

// Matches from other machines' synced memory (.pebbl/mirror/<machine>/).
// Plain substring scan over the parsed projections; returns [] when no
// mirrors exist so search output is unchanged until then.
function searchMirrors(pebblDir, query, cat, topic) {
  // Same AND-of-terms recall fix as the SQLite fallback: mirror search is also
  // a plain substring scan, so a multi-word query must match on all terms
  // rather than the exact adjacent phrase.
  const terms = queryTerms(query);
  const topicMatch = topics => !topic ||
    (topics || '').split(',').map(t => t.trim()).includes(topic);

  const results = [];
  for (const e of mirrorLogs(pebblDir)) {
    if (cat && e.cat !== cat) continue;
    if (!topicMatch(e.topics)) continue;
    if (!matchesAllTerms(e.message, terms)) continue;
    results.push({
      isHandoff: false, machine: e.machine, tier: e.tier, cat: e.cat,
      topics: e.topics, date: e.date, message: e.message,
    });
  }
  // Handoff items carry no category — same as the local handoff paths.
  for (const h of mirrorHandoffs(pebblDir)) {
    if (!topicMatch(h.topics)) continue;
    if (!matchesAllTerms(h.message, terms)) continue;
    results.push({
      isHandoff: true, machine: h.machine, handoffId: h.handoffId,
      field: h.field, status: h.status, topics: h.topics,
      date: h.date, message: h.message,
    });
  }
  return results.slice(0, 10);
}

// If local search ever surfaces an entry that also came back as a mirror match
// (the same memory synced from another machine), it arrives without attribution.
// Drop the local copy and keep the attributed mirror version. No mirrors → no-op.
function mergeMirror(results, mirrorResults) {
  if (mirrorResults.length === 0) return results;
  const mirrorKeys = new Set(mirrorResults.map(r => normalize(r.message)));
  const kept = results.filter(r => {
    const key = normalize(stripHandoffPrefix(r.message || ''));
    return !key || !mirrorKeys.has(key);
  });
  return [...kept, ...mirrorResults];
}

// Drop handoff items that near-duplicate a log entry already in the results —
// the atomic log entry is the authority, the handoff item is a recap of it.
function dedupeResults(results) {
  const logKeys = new Set(
    results.filter(r => !r.isHandoff && r.message).map(r => normalize(r.message))
  );
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = normalize(stripHandoffPrefix(r.message || ''));
    if (r.isHandoff) {
      if (logKeys.has(key)) continue;       // suppressed by an authoritative log entry
      if (seen.has('h:' + key)) continue;    // collapse repeats across handoffs
      seen.add('h:' + key);
    }
    out.push(r);
  }
  return out;
}

// SQLite fallback: scan closed-handoff fields for the query and emit matching items.
function searchHandoffsSqlite(db, query, topic) {
  const terms = queryTerms(query);
  // Row pre-filter: each term must appear in at least one handoff field. This
  // is just to narrow the candidate rows cheaply; the authoritative per-item
  // AND-of-terms check happens below so we don't emit an item that only matches
  // because different terms landed in different fields.
  const perTerm = '(summary LIKE ? OR done LIKE ? OR todo LIKE ? OR blocked LIKE ?)';
  const where = terms.length ? terms.map(() => perTerm).join(' AND ') : '1=1';
  const params = [];
  for (const t of terms) { const like = `%${t}%`; params.push(like, like, like, like); }
  const rows = db.prepare(`
    SELECT id, summary, done, todo, blocked, topics, status, closed_at, timestamp
    FROM handoffs
    WHERE ${where}
  `).all(...params);

  const results = [];
  for (const row of rows) {
    if (topic) {
      const topicParts = (row.topics || '').split(',').map(t => t.trim());
      if (!topicParts.includes(topic)) continue;
    }
    const date = (row.closed_at || row.timestamp || '').slice(0, 10);
    const status = row.status || 'open';
    for (const field of ['done', 'todo', 'blocked']) {
      for (const item of splitItems(row[field])) {
        if (matchesAllTerms(item, terms)) {
          results.push({
            isHandoff: true, handoffId: String(row.id), field, status,
            topics: row.topics, date, message: item,
          });
        }
      }
    }
    if (matchesAllTerms(row.summary, terms)) {
      results.push({
        isHandoff: true, handoffId: String(row.id), field: 'summary', status,
        topics: row.topics, date, message: row.summary,
      });
    }
  }
  return results;
}

function searchSqlite(pebblDir, query, cat, topic, mirrorResults, sourceResults) {
  // Wire 2 — reads-from-fold: events-mode reads the folded view.sqlite (so a
  // pulled events.jsonl is searchable), legacy reads db.sqlite unchanged. This
  // is the only search path that touches a db handle. searchHandoffsSqlite
  // reuses this same handle (handoffs table is in the view too), so both log
  // and handoff hits come from the fold.
  const db = openReadDb(pebblDir);

  // AND-of-terms: each whitespace-delimited term becomes its own LIKE clause,
  // so a multi-word query matches rows containing all the words (in any order),
  // not only rows with the exact adjacent phrase. A blank query (no terms)
  // degrades to "1=1" so it still returns recent rows rather than nothing.
  const terms = queryTerms(query);
  const messageClause = terms.length
    ? terms.map(() => 'message LIKE ?').join(' AND ')
    : '1=1';
  // Bi-temporal (v0.5): search surfaces the CURRENT belief only — superseded
  // entries are excluded by the same `valid_to IS NULL` predicate the context
  // read sites use (one definition, via notCorrected()), instead of the old
  // hide-by-subquery. Their history stays reachable via `pebbl log --history`.
  // `id` is selected for DISPLAY, not filtering: search is where a user finds an
  // older entry to point --relates/--corrects at, so the id has to be on screen.
  let sql = `SELECT id, timestamp, source, category, tier, message, topics FROM logs WHERE tier != 'archived' AND ${notCorrected()} AND ${messageClause}`;
  const params = terms.map(t => `%${t}%`);

  if (cat) {
    sql += ' AND category = ?';
    params.push(cat);
  }
  if (topic) {
    const filter = topicFilter(topic);
    sql += ' ' + filter.clause;
    params.push(...filter.params);
  }

  sql += ' ORDER BY timestamp DESC LIMIT 20';
  const rows = db.prepare(sql).all(...params);

  const logResults = rows.map(row => ({
    isHandoff: false,
    id: row.id,
    tier: row.tier,
    cat: row.category,
    topics: row.topics,
    date: (row.timestamp || '').slice(0, 10),
    message: row.message,
  }));

  const handoffResults = searchHandoffsSqlite(db, query, topic);
  // Source-doc hits rank BELOW curated + mirror entries — appended last.
  const results = [
    ...mergeMirror(dedupeResults([...logResults, ...handoffResults]), mirrorResults || []),
    ...(sourceResults || []),
  ];

  renderResults(query, results);
}

// The single result-printing block, shared by the FTS5 path and the LIKE
// fallback so their output is byte-identical (DRY — one format, not two that
// can drift). "No results found." on an empty set, else the bracketed block.
function renderResults(query, results) {
  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  console.log(`\n--- SEARCH: ${query} ---`);
  for (const r of results) {
    console.log(r.raw || formatResult(r));
    console.log();
  }
  console.log('---\n');
}

// FTS5 + bm25 primary search path (M1). Same CONTRACT and OUTPUT SHAPE as
// searchSqlite — it reuses queryTerms / searchHandoffsSqlite / dedupeResults /
// mergeMirror / formatResult / renderResults verbatim and honors the identical
// filters (tier != 'archived', notCorrected() current-belief, cat, topic, and
// the mirror + source-doc merge). The ONLY difference is HOW the log rows are
// selected and ORDERED: a relevance-ranked FTS5 MATCH (porter-stemmed, synonym
// OR-expanded, phrase/prefix) instead of a substring LIKE scan in insertion
// order. Handoffs keep the LIKE search (the handoffs table carries no FTS index
// — scoped to the logs read path per M1), then both streams merge and render
// together. Throws only on an unexpected SQL error; the caller (search()) wraps
// the call and degrades to searchSqlite on any throw.
function searchFts5(pebblDir, query, cat, topic, mirrorResults, sourceResults) {
  // Same read handle the fallback uses: events-mode -> the folded view.sqlite
  // (carries the FTS index writeViewSqlite built); legacy-mode -> db.sqlite.
  const db = openReadDb(pebblDir);
  // On a writable handle (legacy db.sqlite) ensure the index exists and is
  // current with logs before querying — db.sqlite's log.js appends don't touch
  // FTS, so we rebuild it fresh (milliseconds). On a readonly view.sqlite this
  // is a no-op (db.readonly guard inside buildFtsIndex); its index is already
  // fresh from the fold. "using fts5" for the search read path is logged here
  // under PEBBL_DEBUG so the path is observable without noising normal runs.
  buildFtsIndex(db);
  if (process.env.PEBBL_DEBUG) console.error('pebbl search: using fts5 (bm25 + porter)');

  const match = buildMatchQuery(query);
  // A blank query has no MATCH constraint; fall back to the LIKE path which
  // already degrades a blank query to recent rows (the FTS MATCH grammar has no
  // "match everything" form, and search() already rejects an empty query).
  if (!match) return searchSqlite(pebblDir, query, cat, topic, mirrorResults, sourceResults);

  // Join the external-content FTS table back to `logs` by rowid==id to read the
  // display columns. Filters mirror searchSqlite exactly. ORDER BY bm25(fts), id:
  // bm25 ascending is best-relevance-first (FTS5's score is more-negative=better,
  // so ascending = most relevant first); `id` is the deterministic tie-break that
  // makes equal-score rows order reproducibly across git-synced machines.
  let sql =
    `SELECT l.id, l.timestamp, l.source, l.category, l.tier, l.message, l.topics ` +
    `FROM ${FTS_TABLE} f JOIN logs l ON l.id = f.rowid ` +
    `WHERE f.${FTS_TABLE} MATCH ? AND l.tier != 'archived' AND l.${notCorrected()}`;
  const params = [match];

  if (cat) {
    sql += ' AND l.category = ?';
    params.push(cat);
  }
  if (topic) {
    // topicFilter targets the bare `topics` column; qualify it to l.topics for
    // the join. The clause is a fixed template (no other column named topics in
    // scope here), so a scoped string replace is safe.
    const filter = topicFilter(topic);
    sql += ' ' + filter.clause.replace(/\btopics\b/g, 'l.topics');
    params.push(...filter.params);
  }

  sql += ` ORDER BY bm25(f.${FTS_TABLE}), l.id LIMIT 20`;
  const rows = db.prepare(sql).all(...params);

  const logResults = rows.map(row => ({
    isHandoff: false,
    id: row.id,
    tier: row.tier,
    cat: row.category,
    topics: row.topics,
    date: (row.timestamp || '').slice(0, 10),
    message: row.message,
  }));

  // Handoffs reuse the LIKE search (no FTS on that table — M1 scope); same call
  // searchSqlite makes, so handoff hits are identical between the two paths.
  const handoffResults = searchHandoffsSqlite(db, query, topic);
  const results = [
    ...mergeMirror(dedupeResults([...logResults, ...handoffResults]), mirrorResults || []),
    ...(sourceResults || []),
  ];

  renderResults(query, results);
}

module.exports = function search(args) {
  const { flags, positional } = parseArgs(args);
  const query = positional.join(' ').trim();

  if (!query) {
    console.error('Usage: pebbl search "[query]"');
    process.exit(1);
  }

  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);

  // Wire 2 — reads-from-fold. In events-mode the read path serves the folded
  // view.sqlite, so a just-pulled/merged events.jsonl must be materialized first.
  // ensureFresh folds events.jsonl -> view.sqlite (which now ALSO builds the FTS5
  // index in the same writeViewSqlite seam), so a freshly-pulled store is both
  // searchable and FTS-indexed before we open a handle. Cheap when already fresh
  // (a fingerprint compare, no fold) and best-effort — a fold failure must never
  // break search (the canonical db.sqlite is still there to read).
  if (storeMode(pebblDir) === 'events') {
    try { require('./staleness').ensureFresh(pebblDir); } catch { /* never break search */ }
  }

  const mirrorResults = searchMirrors(pebblDir, query, flags.cat, flags.topic);
  // Read-only [source] discovery hits, ranked BELOW curated entries (appended last).
  const config = loadConfig(pebblDir) || {};
  const sourceResults = searchSources(pebblDir, query, config);

  // Primary path = FTS5 + bm25 (relevance-ranked, porter-stemmed, synonym/prefix);
  // graceful FALLBACK = the LIKE substring scan when FTS5 is unavailable. The
  // capability probe opens a read handle and asks fts5Available(db): FTS5 must be
  // compiled in AND either the index already exists (a folded view.sqlite) or we
  // can build it on this handle (writable legacy db.sqlite). FTS5 is the only
  // search backend.
  // Any throw from the FTS path degrades to the identical-shape LIKE search, so a
  // store that somehow can't be FTS-indexed still returns results.
  let useFts5 = false;
  try {
    const probe = openReadDb(pebblDir);
    try { useFts5 = fts5Available(probe); } finally { probe.close(); }
  } catch { useFts5 = false; }

  if (useFts5) {
    try {
      searchFts5(pebblDir, query, flags.cat, flags.topic, mirrorResults, sourceResults);
      return;
    } catch {
      // FTS path failed unexpectedly — fall through to the LIKE search so the
      // command still returns results (graceful degradation, same output shape).
    }
  }
  searchSqlite(pebblDir, query, flags.cat, flags.topic, mirrorResults, sourceResults);
};

module.exports._internal = { dedupeResults, formatResult, stripHandoffPrefix, normalize, queryTerms, matchesAllTerms, searchHandoffsSqlite, searchMirrors, mergeMirror, searchSources, searchSqlite, searchFts5, buildMatchQuery, SYNONYM_GROUPS, SYNONYM_INDEX, renderResults };
