'use strict';
// `pebbl readback <spec-file | -> [--json] [--top N]` — surface colliding prior
// work for an incoming task spec BEFORE the agent writes any code, so it
// resumes/supersedes instead of reinventing (the 31% stale-spec class). This is
// the first of three self-learning primitives (readback -> liveness -> encode);
// full rationale: notes/design-selflearning-primitives-2026-06-23.md §0/§1/§4.
//
// DETERMINISTIC, NO-LLM. readback SELECTS and EXPOSES structure; the agent
// judges. It makes the collision AVAILABLE; whether the agent OBEYS is the L20
// structural-read half, which is PLANNED elsewhere and explicitly NOT this
// command's job.
//
// WHY NOT context.js findRelatedCommits: that extractor drops every token <=3
// chars (`w.length > 3`) and gates on `score >= 2`, so it would lose the short
// slice-ids (S0, v2) and single-artifact collisions this command exists to
// catch. readback uses its OWN identifier-aware extractor + routes matching
// through search.js's FTS5 query builder (porter stemming + synonym expansion +
// bm25) so a paraphrase/rename still has a chance.

const fs = require('fs');
const Database = require('better-sqlite3');
const { requirePebblDir } = require('./find-pebbl');
const { readEvents } = require('./events');
const { fold, isRollupMessage } = require('./fold');
const { buildFtsIndex, FTS_TABLE, fts5Compiled } = require('./db');
const { rankCandidates } = require('./rank');
// Reuse search.js's ONE query builder (and, transitively, its ONE tokenizer
// queryTerms) so readback's MATCH grammar, synonym OR-expansion and prefix
// behavior are identical to `pebbl search` — DRY, and we never fork the FTS
// semantics. We do NOT change search.js; we only consume its _internal export.
const { buildMatchQuery, queryTerms } = require('./search')._internal;
const { renderFactoryGuide } = require('./factory-guide'); // ONE printer, shared by the trio

// ── reasoning subset (the real fold schema) ──────────────────────────────────
//
// The collision corpus is the REASONING the factory recorded, not its firehose.
// Include only folded `append` rows whose category is one of the real reasoning
// categories AND whose tier is durable. EXCLUDE: the commit stream (folds out as
// non-append rows — the 246-deep firehose, no category), the hook projection-
// sync appends (source=='hook'), and fleeting tier (ephemeral). This is the F4
// fix: it keeps `quality` (the strongest real precedents carry it) and drops
// `quality-with-artifact`, which was never a real category.
const REASONING_CATEGORIES = new Set([
  'decision', 'steering', 'pattern', 'integration', 'structure', 'quality',
  // `correction` is the deprecated alias of `steering`; old already-stored rows
  // still carry it, so keep it here to fold them into the reasoning subset on
  // READ (the rename is forward-only — we never rewrite the log).
  'correction',
]);
const DURABLE_TIERS = new Set(['foundation', 'component', 'detail']);

// A folded row is in the reasoning subset when it is an append-origin row in a
// reasoning category and a durable tier, and was NOT written by the hook. fold()
// rows carry no `type` (they are already-reduced log rows; commits fold into a
// separate side channel, never into logs), so "type=='append'" is expressed as
// "it is a log row that is not a hook projection" — the commit firehose simply
// is not in this array. We still guard source!=='hook' explicitly.
function isReasoningRow(row) {
  if (!row) return false;
  if (row.source === 'hook') return false;            // projection-sync, not reasoning
  if (!REASONING_CATEGORIES.has(row.category)) return false;
  if (!DURABLE_TIERS.has(row.tier)) return false;
  return true;
}

// Read the store's events, fold to the live row set, keep the reasoning subset.
// Folding (not a db read) keeps readback independent of whether view.sqlite has
// been materialized, and gives the same current-belief set every other read
// path sees (superseded rows fold to valid_to != null, but they still carry a
// real prior decision — we keep them as candidates; the agent judges currency).
function loadReasoningRows(pebblDir) {
  const rows = fold(readEvents(pebblDir));
  // EXCLUDE compaction rollups. readback's contract is "resume or supersede this
  // prior work, do not rebuild it" — but a rollup is the compactor's own output,
  // joining many unrelated facts into one row. There is nothing in it a builder
  // can resume and nothing they can supersede, so it can never satisfy that
  // contract.
  //
  // Measured (eval/readback-recall/BASELINE.md): on a 261-row snapshot of loom's
  // store, rollups were 5 rows (1.9%) running 25k-185k characters against a
  // 1034-char median, and they took rank 1 on 8 of 10 eval queries. Worse than
  // crowding — because a rollup accumulates a quarter of text it ends up naming
  // EVERY file in the corpus, so it trips the artifact path and comes back
  // flagged `collision: true`, telling the caller "prior work exists, do not
  // rebuild" on the strength of a storage artifact. Excluding them lifted
  // artifact-named recall@1 from 0.20 to 1.00 on a corpus three times larger.
  //
  // This narrows what readback offers as a PRECEDENT. It hides nothing: rollups
  // stay in the fold, so `pebbl search`, `pebbl context` and the markdown
  // projections are untouched.
  return rows.filter((r) => isReasoningRow(r) && !isRollupMessage(r.message));
}

// ── identifier-aware extraction (F2 fix) ─────────────────────────────────────
//
// Two token classes come out of a spec:
//   identifiers — the things that make a COLLISION real: code identifiers, file
//                 paths (*.ext), short alnum slice-ids (S0, M1, v2, CI), quoted
//                 commands, CapitalizedArtifact names. Short tokens (<=3 chars)
//                 are KEPT here — that is the whole point (context.js drops them).
//   topics      — ordinary words, lowercased, for the FTS query text only. NEVER
//                 sufficient to flag a collision (factory/review/promote must not
//                 trip it).
//
// The identifier set is what collision overlap is computed against; the full
// token text (identifiers + topics) is what we hand to buildMatchQuery so FTS5
// can stem/expand and rank. Keeping the two separate is the F9 fix: matching is
// generous (recall), collision is strict (an identifier/artifact/path hit).

// Words that must NEVER anchor a collision even when they look like (or are a
// component of) an identifier — they are AMBIENT vocabulary: factory process
// words plus generic engineering verbs/nouns common enough that two entries
// sharing only one of them are NOT about the same artifact. (F9: "never a topic
// word like factory/review/promote".) This is the ONE place that judgement
// lives, kept obviously extensible — proven ambient words, not a thesaurus.
//
// TWO bands:
//   process — factory/pipeline vocabulary (factory, review, promote, staging…).
//   generic-eng — verbs/nouns that show up as a piece of many identifiers
//                 (write_heartbeat, state-machine, queue-runner…): write, read,
//                 state, queue, command, etc. Distinctive domain terms
//                 (triage, watermark, heartbeat) are deliberately NOT here.
const COLLISION_STOPWORDS = new Set([
  // process / factory ambient
  'factory', 'review', 'promote', 'fix', 'task', 'test', 'tests', 'build',
  'pebbl', 'agent', 'staging', 'main', 'code', 'work', 'pipeline', 'gate',
  'spec', 'file', 'add', 'the', 'and', 'for', 'with', 'from', 'this', 'that',
  'merged', 'fixture', 'fixtures', 'pass', 'fail',
  // generic engineering verbs/nouns (a single shared one != same artifact)
  'write', 'read', 'reads', 'writes', 'state', 'queue', 'command', 'commands',
  'suite', 'token', 'tokens', 'bucket', 'active', 'already', 'double', 'sweep',
  'seed', 'seeds', 'resolved', 'production', 'mutated', 'coordination',
  'priority', 'leaky', 'wire', 'value', 'values', 'data', 'flow', 'flows',
]);

// File-path-ish: contains a slash, OR ends in a known-ish extension. We don't
// hard-code an extension list (ETC — easier to change): a dot followed by 1..6
// alnum chars at a token's end is treated as an extension.
function looksLikePath(tok) {
  if (tok.includes('/')) return true;
  return /\.[a-z0-9]{1,6}$/i.test(tok);
}

// Slice-id-ish: a letter-then-digit short tag (S0, M1, v2) or a SHORT (2-3 char)
// all-caps acronym (CI, FF, DRY). These are exactly the <=3-char tokens
// context.js throws away. The all-caps branch is capped at 3 chars on purpose: a
// 4+-char all-caps word in prose is almost always an English word shouted for
// emphasis ("PASS", "WRITE", "DONE"), NOT a slice-id — letting those through
// made generic words anchor false collisions.
function looksLikeSliceId(tok) {
  return /^[A-Za-z]+\d+[A-Za-z0-9]*$/.test(tok) || /^[A-Z]{2,3}$/.test(tok);
}

// Code-identifier-ish: snake_case, kebab-case, camelCase, dotted (a.b),
// has-a-digit, or a CapitalizedArtifact name. Anything that reads as "a name a
// program or a person deliberately coined", not an English word.
function looksLikeIdentifier(tok) {
  if (looksLikePath(tok)) return true;
  if (looksLikeSliceId(tok)) return true;
  if (/[_]/.test(tok)) return true;                         // snake_case
  if (/[a-z0-9]-[a-z0-9]/i.test(tok)) return true;          // kebab-case (mid-token hyphen)
  if (/[a-z][A-Z]/.test(tok)) return true;                  // camelCase
  if (/\d/.test(tok)) return true;                          // carries a digit
  // CapitalizedArtifact (Foo, BookForge): a leading cap THEN at least one
  // lowercase. The mandatory lowercase is what separates a real artifact name
  // from an all-caps word shouted in prose (PASS, DONE, WIRE) — those have no
  // lowercase and must NOT read as identifiers, or generic words anchor false
  // collisions.
  if (/^[A-Z][a-z][A-Za-z]*$/.test(tok) && tok.length >= 4) return true;
  return false;
}

// Explode an identifier/path token into its DISTINCTIVE component words. A real
// artifact name is usually a compound (test-triage-watermark.sh,
// payment_retry.go, fixTriageSeed), and a paraphrased spec rarely reproduces the
// exact compound — it names a PIECE of it ("the triage watermark test"). So the
// unit that makes a collision real is the shared distinctive component, not only
// the verbatim compound. Split on / . - _ and camelCase boundaries, lowercase,
// drop the extension-ish and ambient pieces and anything shorter than 4 chars
// (so a short connective like "to"/"sh" can't anchor a collision; the whole
// short SLICE-id like S0 is handled separately as its own identifier).
function componentsOf(token) {
  const parts = String(token)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // camelCase -> camel Case
    .split(/[\s/._\-]+/)
    .map((p) => p.toLowerCase().replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '')) // strip edge punctuation a sentence left attached (heartbeat) -> heartbeat
    .filter((p) => p.length >= 4 && !COLLISION_STOPWORDS.has(p) && !/^\d+$/.test(p));
  return parts;
}

// Identifier/artifact tokens an ENTRY owns, exploded to distinctive components,
// PLUS the verbatim identifiers themselves. This is the entry SIDE of a
// collision: a query component collides only if it matches a token the entry
// carries AS PART OF AN IDENTIFIER/PATH — never a bare topic word. We scan the
// entry's message for identifier/path-shaped tokens (same shape test the spec
// extractor uses) and union their components + the full identifier strings.
function entryArtifacts(entry) {
  const text = `${entry.message || ''}`;
  const arts = new Set();
  for (const tok of rawTokens(text)) {
    const lower = tok.toLowerCase();
    if (!looksLikeIdentifier(tok) || COLLISION_STOPWORDS.has(lower)) continue;
    arts.add(lower);                          // the verbatim identifier/path
    const base = lower.includes('/') ? lower.split('/').pop() : lower;
    if (base) arts.add(base);
    for (const c of componentsOf(lower)) arts.add(c);
  }
  return arts;
}

// Pull double-quoted / backtick-quoted runs out FIRST (quoted commands like
// `git rebase -i` or "pebbl readback"): the whole quoted run is one identifier
// candidate AND its inner tokens are re-scanned individually. Returns the list
// of quoted runs (lowercased, trimmed) found in the text.
function extractQuotedRuns(text) {
  const runs = [];
  const re = /[`"']([^`"']{2,80})[`"']/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1].trim().toLowerCase();
    if (inner && /\s/.test(inner)) runs.push(inner); // multi-word quoted command
  }
  return runs;
}

// Tokenize on whitespace, then strip surrounding punctuation that is not part of
// an identifier (commas, parens, sentence periods) while PRESERVING in-token
// dots/slashes/hyphens/underscores. A trailing sentence period is removed only
// when the remaining token does NOT itself look like a path (so "file.sh." ->
// "file.sh" but "v2." -> "v2").
function rawTokens(text) {
  return (text || '')
    .split(/\s+/)
    .map((t) => t.replace(/^[("'`\[]+/, '').replace(/[)"'`\],;:!?]+$/, ''))
    .map((t) => {
      // a single trailing dot that is sentence punctuation (token isn't a path)
      if (t.endsWith('.') && !looksLikePath(t.slice(0, -1))) return t.slice(0, -1);
      return t;
    })
    .filter(Boolean);
}

// extract(spec) -> { identifiers:Set<lowercased>, topics:Set<lowercased>, queryText }.
// identifiers drive collision; topics are context; queryText (identifiers UNION
// topics, space-joined) is what buildMatchQuery stems/expands/ranks. Short
// identifiers are kept; ambient topic words can never become identifiers.
function extract(spec) {
  const text = String(spec || '');
  const identifiers = new Set();
  const topics = new Set();
  // salient = the QUERY side of a collision: every distinctive token a shared
  // artifact could turn on. It unions verbatim identifiers, their exploded
  // components, AND distinctive (>=4-char, non-ambient) topic words — because a
  // paraphrased spec names a PIECE of an artifact as a plain word ("watermark"),
  // and that piece only ever flags a collision when it also appears as part of
  // an IDENTIFIER in the matched entry (entryArtifacts). So a bare topic word in
  // the ENTRY can never trip it; the rule "never a topic word" holds on the side
  // that matters.
  const salient = new Set();

  // Quoted multi-word commands: the run itself is a strong identifier signal.
  for (const run of extractQuotedRuns(text)) { identifiers.add(run); salient.add(run); }

  for (const tok of rawTokens(text)) {
    const lower = tok.toLowerCase();
    if (lower.length === 0) continue;
    const isId = looksLikeIdentifier(tok);
    // An identifier-shaped token anchors collision UNLESS it is an ambient
    // factory word. A plain English word is a topic only.
    if (isId && !COLLISION_STOPWORDS.has(lower)) {
      identifiers.add(lower);
      salient.add(lower);
      for (const c of componentsOf(lower)) salient.add(c);   // pieces collide too
      // a path also contributes its basename as an identifier (test-x.sh -> test-x.sh
      // already kept; also keep the dotless stem so a rename that drops .sh still hits)
      if (looksLikePath(lower)) {
        const base = lower.split('/').pop();
        if (base) { identifiers.add(base); salient.add(base); }
        const stem = base ? base.replace(/\.[a-z0-9]{1,6}$/i, '') : '';
        if (stem && stem.length >= 4 && !COLLISION_STOPWORDS.has(stem)) { identifiers.add(stem); salient.add(stem); }
      }
    } else if (lower.length >= 3 && !COLLISION_STOPWORDS.has(lower)) {
      topics.add(lower);
      // A distinctive (>=4-char) topic word is a candidate collision component:
      // it can only ever FIRE against an entry's artifact component, never an
      // entry's bare topic word (see entryArtifacts / collisionFor).
      if (lower.length >= 4) salient.add(lower);
    }
  }

  const queryText = [...identifiers, ...topics].join(' ');
  return { identifiers, topics, salient, queryText };
}

// ── matching via search.js's FTS5 path ───────────────────────────────────────
//
// Build a throwaway in-memory SQLite, materialize the reasoning rows into a
// `logs` table, and build the SAME external-content FTS5 index db.js builds for
// search (db.buildFtsIndex — porter stemming), then query through search.js's
// SAME grammar (queryTerms tokenizer + buildMatchQuery — synonym OR-expansion,
// injection-safe quoting). This routes readback's matching through search.js +
// db.js VERBATIM (no edits to either) and needs no materialized view.sqlite.
//
// WHY PER-TERM OR, not one AND-match: `pebbl search` AND-joins every term (all
// must be present — its recall model). A PARAPHRASED spec shares MOST but rarely
// ALL of an entry's terms ("the live heartbeat file" vs an entry that never says
// "live"), so a single AND-match would miss the very precedent readback exists
// to surface. So matching here is GENEROUS: run buildMatchQuery PER query term
// (each still synonym-expanded + quoted by search.js) and aggregate — an entry's
// rank is how MANY distinct query terms it hit (termHits), then summed bm25.
// Recall is generous on purpose; the strict gate is COLLISION (collisionFor),
// not this match. Returns rows best-first with {termHits, score}.
function matchRows(rows, queryText) {
  if (rows.length === 0) return [];
  const terms = queryTerms(queryText);
  if (terms.length === 0) return [];

  const db = new Database(':memory:');
  try {
    if (!fts5Compiled(db)) return [];        // no FTS5 -> no matches (caller handles empty)
    db.exec(
      'CREATE TABLE logs (id INTEGER PRIMARY KEY, message TEXT, tier TEXT, ' +
      'category TEXT, topics TEXT, eid TEXT, importance REAL, access_count INTEGER)'
    );
    const ins = db.prepare(
      'INSERT INTO logs (id, message, tier, category, topics, eid, importance, access_count) ' +
      'VALUES (?,?,?,?,?,?,?,?)'
    );
    rows.forEach((r, i) => {
      ins.run(
        i + 1,
        r.message || '',
        r.tier || '',
        r.category || '',
        r.topics || '',
        r.eid || '',
        r.importance == null ? null : r.importance,
        r.access_count == null ? null : r.access_count
      );
    });
    // Same DDL + rebuild as the search read path (db.buildFtsIndex).
    if (!buildFtsIndex(db)) return [];

    const stmt = db.prepare(
      `SELECT l.id, bm25(f.${FTS_TABLE}) AS rank ` +
      `FROM ${FTS_TABLE} f JOIN logs l ON l.id = f.rowid ` +
      `WHERE f.${FTS_TABLE} MATCH ?`
    );
    const meta = db.prepare(
      'SELECT id, message, tier, category, topics, eid, importance, access_count FROM logs'
    ).all();
    const byId = new Map(meta.map((m) => [m.id, m]));

    // Per-term: each buildMatchQuery(term) is a single-term, synonym-expanded,
    // quoted MATCH (injection-safe by search.js's ftsQuote). Tally per entry.
    const agg = new Map(); // id -> { termHits, sumNegBm25 }
    for (const term of terms) {
      const match = buildMatchQuery(term);
      if (!match) continue;
      let hits;
      try { hits = stmt.all(match); } catch { continue; } // never throw on one bad term
      for (const h of hits) {
        const cur = agg.get(h.id) || { termHits: 0, sumNegBm25: 0 };
        cur.termHits += 1;
        cur.sumNegBm25 += (-h.rank); // bm25 is more-negative=better; accumulate positive
        agg.set(h.id, cur);
      }
    }
    if (agg.size === 0) return [];

    // Rank: most distinct query terms hit first (paraphrase coverage), then the
    // summed bm25 relevance, then id ASC for a deterministic, machine-stable tie.
    const ranked = [...agg.entries()]
      .map(([id, a]) => ({ id, ...a }))
      .sort((x, y) =>
        (y.termHits - x.termHits) ||
        (y.sumNegBm25 - x.sumNegBm25) ||
        (x.id - y.id)
      );

    return ranked.map((a) => {
      const m = byId.get(a.id);
      // The in-memory table above exists ONLY to compute a bm25 rank, so it
      // carries just the columns FTS needs. Domain fields that never enter it
      // must be read back off the ORIGINAL row, which is why R4's outcome /
      // occurrences are sourced from `rows` (id was assigned as i + 1 in the
      // insert loop) rather than from `m`. Anything added to the logs row in
      // future needs the same treatment or it silently arrives as undefined.
      const orig = rows[a.id - 1] || {};
      return {
        eid: m.eid,
        message: m.message,
        tier: m.tier,
        category: m.category,
        topics: m.topics,
        importance: m.importance,
        access_count: m.access_count,
        outcome: orig.outcome == null ? null : orig.outcome,
        occurrences: Number.isInteger(orig.occurrences) && orig.occurrences > 0
          ? orig.occurrences
          : 1,
        termHits: a.termHits,
        score: Math.round(a.sumNegBm25 * 1000) / 1000,
      };
    });
  } finally {
    db.close();
  }
}

// ── collision detection (F9/F3 fix) ──────────────────────────────────────────
//
// A match COLLIDES when the query's distinctive tokens (`salient`) intersect the
// tokens the ENTRY carries AS PART OF AN IDENTIFIER/ARTIFACT/PATH
// (`entryArtifacts`). A single shared artifact-component is enough — NO score>=2
// gate. The intersection is, by construction, NEVER a bare topic word: the entry
// side only contributes pieces of real identifiers/paths, and ambient factory
// words (factory/review/promote) are stopword-filtered on BOTH sides. So a
// paraphrased "the triage watermark test" collides with an entry that owns
// `test-triage-watermark.sh` (shared component `watermark`/`triage`), while two
// entries that merely share the topic word "factory" do not. matched_on lists
// exactly the shared components so the agent sees WHY it collided.
//
// Path-ish salient tokens also try a basename/substring match against the
// entry's verbatim identifiers (so `state/triage-heartbeat.txt` in the spec
// still collides with an entry naming `triage-heartbeat.txt` under a different
// dir). Otherwise it is a set intersection on exploded components.
function collisionFor(entry, salient) {
  const arts = entryArtifacts(entry);
  if (arts.size === 0) return [];
  const matched = [];
  for (const s of salient) {
    if (!s) continue;
    if (arts.has(s)) { matched.push(s); continue; }
    // path-ish salient token: also match by basename against the entry's arts.
    if (s.includes('/') || /\.[a-z0-9]{1,6}$/i.test(s)) {
      const base = s.split('/').pop();
      if (base && arts.has(base)) { matched.push(base); continue; }
    }
  }
  // De-dup while preserving discovery order.
  return [...new Set(matched)];
}

// A one-line, NO-LLM verdict hint. readback never decides; it labels the shape
// so the agent (or L20) can route. COLLISION -> resume/supersede; otherwise a
// plain related-context note.
function verdictHint(collision, matchedOn) {
  if (collision) {
    return `COLLISION on ${matchedOn.join(', ')} — prior work exists; resume or supersede, do not rebuild`;
  }
  return 'related context only (no shared artifact) — read before building, but not a duplicate';
}

// ── the collision ranking lane (F8 fix) ──────────────────────────────────────
//
// Collision-bearing matches sort ABOVE every non-collision match. WITHIN the
// collision set, order by the importance/usage rerank (rank.js), so a hotter /
// more important precedent leads; ties fall to rerank's own deterministic id
// tiebreak. A hot, newer, same-TOPIC non-collision entry can never outrank a
// true artifact collision. The non-collision tail keeps bm25 order (already the
// input order from matchRows).
function rankResults(matches, salient) {
  const enriched = matches.map((m, i) => {
    const matchedOn = collisionFor(m, salient);
    // id is assigned so that the BETTER bm25 match (lower input index i) gets the
    // HIGHER id — rank.js's tiebreak is id DESC, so at equal importance/usage
    // (the common case here, since folded rows carry no importance/access_count)
    // the better bm25 match leads WITHIN the collision set. matchRows already
    // sorted `matches` best-first.
    return { ...m, __id: matches.length - i, matched_on: matchedOn, collision: matchedOn.length > 0 };
  });

  const collisions = enriched.filter((e) => e.collision);
  const rest = enriched.filter((e) => !e.collision);

  // rerank only ORDERS within the collision set (importance/usage, then id DESC).
  // rank.js reads importance/access_count/relevance; we leave relevance unset
  // (flat), so ordering is importance-then-usage-then-id-DESC, exactly its
  // contract — a true artifact collision can never be outranked by a hotter
  // same-topic NON-collision entry, because non-collisions are appended AFTER.
  const rankedCollisions = rankCandidates(
    collisions.map((e) => ({ ...e, id: e.__id }))
  );

  // rest stays in bm25 order (matchRows already sorted it).
  return [...rankedCollisions, ...rest].map((e) => ({
    eid: e.eid,
    matched_on: e.matched_on,
    score: e.score,
    collision: e.collision,
    // R4 failure memory. The reason readback exists is to stop an agent
    // rebuilding what already happened — and "someone already tried this and it
    // did NOT work" is the most expensive precedent to miss. Surfacing it here
    // is what keeps `--outcome` from being a column nobody reads. Normalized to
    // null when absent so the shape is stable for `--json` consumers (loom's
    // memory.ts parses this array).
    outcome: (e.outcome === 'failed' || e.outcome === 'worked') ? e.outcome : null,
    // How many times the fact was asserted (R4 identity key). 1 for every
    // pre-v0.8 row and every keyless entry, so the field is always a number.
    occurrences: Number.isInteger(e.occurrences) && e.occurrences > 0 ? e.occurrences : 1,
    verdict_hint: verdictHint(e.collision, e.matched_on),
  }));
}

// computeReadback(pebblDir, specText) -> the ranked result array (deterministic
// given the store rows). Exposed for tests and used by the CLI. The spec is
// extracted ONCE (identifiers/topics/salient + queryText); matching uses
// queryText, collision uses salient.
function computeReadback(pebblDir, specText, opts = {}) {
  const { salient, queryText } = extract(specText);
  const rows = loadReasoningRows(pebblDir);
  const matches = matchRows(rows, queryText);
  const ranked = rankResults(matches, salient);
  const top = Number(opts.top);
  return Number.isFinite(top) && top > 0 ? ranked.slice(0, top) : ranked;
}

// ── --factory-guide (inverted manifest, B3 fix) ──────────────────────────────
//
// A STATIC manifest of TRIGGER-CONDITIONS (call_when/precondition/effect/
// consumes/produces), NOT host stage names — a host factory binds its own
// stages. EVERY edge carries status: BUILT|PLANNED; the integrating agent treats
// PLANNED as "surface it, do not wire." pebbl only emits edges it can name from
// its own siblings (pebbl search = BUILT) plus the one declared downstream that
// is NOT yet built (L20 structural-read = PLANNED). No store access.
const FACTORY_GUIDE = {
  command: 'readback',
  call_when: 'a task is about to be claimed/started, before any code is written',
  precondition: 'you have the task spec text (a file path or stdin)',
  effect: 'a COLLISION result means STOP and resume/supersede the prior work, do not rebuild',
  consumes: 'task spec text',
  produces: 'ranked colliding precedents: [{eid, matched_on, score, collision, verdict_hint}]',
  edges: [
    { to: 'pebbl search', status: 'BUILT' },             // the FTS5 query path readback rides
    { to: 'L20 structural-read', status: 'PLANNED' },     // the "agent must obey the collision" half
  ],
};

function printFactoryGuide(asJson) {
  process.stdout.write(renderFactoryGuide(FACTORY_GUIDE, { json: asJson }));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
//
// We parse our OWN flags from raw argv (not src/args.js) because --factory-guide
// / --top are not in args.js's KNOWN_FLAGS and this task must not touch args.js;
// the same raw-arg approach context.js uses for --full. --json and --top are
// honored; the positional is the spec FILE path, or `-` for stdin.
function parseReadbackArgs(args) {
  const out = { json: false, factoryGuide: false, top: null, specPath: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--factory-guide') { out.factoryGuide = true; continue; }
    if (a === '--top' || a === '--top-n') {
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith('--')) { out.top = Number(v); i++; }
      continue;
    }
    if (a.startsWith('--top=')) { out.top = Number(a.slice('--top='.length)); continue; }
    if (a.startsWith('--')) continue;             // ignore unknown flags
    if (out.specPath === null) out.specPath = a;  // first positional is the spec source
  }
  return out;
}

// Read the spec text from a file path, or from stdin when the arg is '-'.
function readSpecText(specPath) {
  if (specPath === '-' || specPath == null) {
    try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
  }
  return fs.readFileSync(specPath, 'utf8');
}

// Human render of the result list (the non-JSON default).
function printResults(results) {
  if (results.length === 0) {
    process.stdout.write('No colliding precedents found.\n');
    return;
  }
  const out = ['\n--- READBACK: colliding / related precedents ---'];
  for (const r of results) {
    const tag = r.collision ? 'COLLISION' : 'related';
    out.push(`[${tag}] ${r.eid}  (score ${r.score})`);
    if (r.matched_on.length) out.push(`  matched on: ${r.matched_on.join(', ')}`);
    // Lead with the failure when there is one: a precedent that was TRIED and
    // did not work changes what the reader should do, so it outranks the
    // generic verdict hint in the printed output.
    if (r.outcome === 'failed') {
      out.push(`  ALREADY TRIED — did NOT work${r.occurrences > 1 ? ` (seen ${r.occurrences}x)` : ''}`);
    } else if (r.outcome === 'worked') {
      out.push(`  already tried — WORKED${r.occurrences > 1 ? ` (seen ${r.occurrences}x)` : ''}`);
    }
    out.push(`  ${r.verdict_hint}`);
    out.push('');
  }
  out.push('---\n');
  process.stdout.write(out.join('\n') + '\n');
}

module.exports = function readback(args) {
  const opts = parseReadbackArgs(args);

  // --factory-guide is a STATIC manifest: no store, no spec needed.
  if (opts.factoryGuide) {
    printFactoryGuide(opts.json);
    return;
  }

  if (opts.specPath == null) {
    console.error('Usage: pebbl readback <spec-file | -> [--json] [--top N]');
    console.error('       pebbl readback --factory-guide [--json]');
    process.exit(1);
  }

  const pebblDir = requirePebblDir();
  let specText;
  try {
    specText = readSpecText(opts.specPath);
  } catch (err) {
    console.error(`pebbl readback: cannot read spec '${opts.specPath}': ${err.message}`);
    process.exit(1);
  }

  const results = computeReadback(pebblDir, specText, { top: opts.top });

  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    return;
  }
  printResults(results);
};

// Internal surface for tests (pure pieces + the manifest), mirroring how
// search.js exposes _internal.
module.exports._internal = {
  extract, looksLikeIdentifier, looksLikePath, looksLikeSliceId,
  componentsOf, entryArtifacts,
  isReasoningRow, loadReasoningRows, matchRows, collisionFor, rankResults,
  computeReadback, verdictHint, parseReadbackArgs, FACTORY_GUIDE,
  REASONING_CATEGORIES, DURABLE_TIERS, COLLISION_STOPWORDS,
};
