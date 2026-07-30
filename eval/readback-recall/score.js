'use strict';
// Score `pebbl readback` recall against a labelled question set.
//
//   node eval/readback-recall/score.js <path-to-.pebbl> [--json] [--top N]
//
// WHY THIS EXISTS: readback is the read-first collision check loom runs before
// it builds anything, so its RECALL bounds how much prior work loom can avoid
// rebuilding. Collision PRECISION is already measured on the live corpus; recall
// is not measured anywhere, and recall is the number a node/edge graph claims to
// move. Measure it before changing storage, or there is no way to tell whether
// the change helped (and the pre-R4 duplicate-heavy corpus would have flattered
// any after-measurement taken too early).
//
// READS ONLY. It opens no db handle of its own beyond what computeReadback does,
// writes nothing to the store, and never mutates the question set.
//
// The question set is the stable artifact; the corpus is whatever store you
// point it at. Corpus size is printed with every run precisely because the score
// is only comparable across runs on a comparable corpus.
const fs = require('fs');
const path = require('path');
const readback = require('../../src/readback');
const { fold } = require('../../src/fold');
const { readEvents } = require('../../src/events');

const QUESTIONS = path.join(__dirname, 'questions.json');

function parse(argv) {
  const out = { store: null, json: false, top: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--top') { out.top = parseInt(argv[++i], 10); continue; }
    if (!a.startsWith('--')) out.store = a;
  }
  return out;
}

// 1-based rank of the expected eid, or 0 when it never appears.
function rankOf(results, eid) {
  for (let i = 0; i < results.length; i++) {
    if (results[i].eid === eid) return i + 1;
  }
  return 0;
}

function summarize(rows) {
  const n = rows.length;
  if (n === 0) return { n: 0, recall_at_1: 0, recall_at_5: 0, mrr: 0 };
  const at1 = rows.filter(r => r.rank === 1).length;
  const at5 = rows.filter(r => r.rank >= 1 && r.rank <= 5).length;
  const mrr = rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n;
  return {
    n,
    recall_at_1: +(at1 / n).toFixed(3),
    recall_at_5: +(at5 / n).toFixed(3),
    mrr: +(mrr).toFixed(3),
  };
}

function main() {
  const opts = parse(process.argv.slice(2));
  if (!opts.store) {
    console.error('usage: node eval/readback-recall/score.js <path-to-.pebbl> [--json] [--top N]');
    process.exit(1);
  }
  const store = path.resolve(opts.store);
  if (!fs.existsSync(store)) {
    console.error(`no such store: ${store}`);
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(QUESTIONS, 'utf8'));

  // Corpus fingerprint. A recall number is only comparable to another taken on a
  // comparable corpus, so record the size rather than leaving it implicit.
  const allRows = fold(readEvents(store));
  const reasoning = allRows.filter(readback._internal.isReasoningRow);

  const rows = spec.questions.map((q) => {
    const results = readback._internal.computeReadback(store, q.query, { top: opts.top });
    const rank = rankOf(results, q.expect);
    // Was the expected precedent even present in the corpus? A missing target
    // is a BROKEN QUESTION, not a recall failure, and must never be scored as
    // one — that is how an eval quietly starts measuring its own bookkeeping.
    const present = allRows.some(r => r.eid === q.expect);
    return {
      id: q.id,
      tier: q.tier,
      expect: q.expect,
      present,
      rank,
      returned: results.length,
      top_eid: results.length ? results[0].eid : null,
    };
  });

  const missing = rows.filter(r => !r.present);
  const scored = rows.filter(r => r.present);
  const byTier = {};
  for (const t of [...new Set(scored.map(r => r.tier))]) {
    byTier[t] = summarize(scored.filter(r => r.tier === t));
  }

  const report = {
    store,
    corpus_rows: allRows.length,
    corpus_reasoning_rows: reasoning.length,
    top: opts.top,
    overall: summarize(scored),
    by_tier: byTier,
    broken_questions: missing.map(r => r.id),
    rows,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  console.log(`\nreadback recall — ${store}`);
  console.log(`corpus: ${allRows.length} rows (${reasoning.length} reasoning), top=${opts.top}\n`);
  console.log('  id   tier             rank  expected');
  console.log('  ---  ---------------  ----  --------------------------');
  for (const r of rows) {
    const rank = !r.present ? ' n/a' : (r.rank ? String(r.rank).padStart(4) : ' MISS');
    console.log(`  ${r.id.padEnd(3)}  ${r.tier.padEnd(15)}  ${rank}  ${r.expect}`);
  }
  console.log('');
  for (const [tier, s] of Object.entries(byTier)) {
    console.log(`  ${tier.padEnd(15)}  n=${s.n}  recall@1 ${s.recall_at_1}  recall@5 ${s.recall_at_5}  MRR ${s.mrr}`);
  }
  const o = report.overall;
  console.log(`  ${'OVERALL'.padEnd(15)}  n=${o.n}  recall@1 ${o.recall_at_1}  recall@5 ${o.recall_at_5}  MRR ${o.mrr}`);
  if (missing.length) {
    console.log(`\n  WARNING: ${missing.length} question(s) reference an eid absent from this corpus (${missing.map(r => r.id).join(', ')}) — excluded from scoring, fix the labels.`);
  }
  console.log('');
}

main();
