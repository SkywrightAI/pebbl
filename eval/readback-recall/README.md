# readback-recall

Measures **recall** of `pebbl readback` — the read-first collision check loom runs
before it builds anything. Readback's recall bounds how much prior work loom can
avoid rebuilding, and until this harness there was no number for it.

This is a measurement harness, not a test. It lives outside `test/` on purpose:
`npm test` must stay deterministic pass/fail, and a recall score is a number that
moves with the corpus.

```bash
node eval/readback-recall/score.js ~/loom/.pebbl          # human-readable
node eval/readback-recall/score.js ~/loom/.pebbl --json   # machine-readable
```

Read-only. It never writes to the store.

## What it measures, and what it deliberately does not

**Recall**, not collision precision. Precision is already measured on loom's live
corpus (the self-fix lane: 100% collision rate over 34 findings, with the rarity
floor admitting loom's whole domain vocabulary). Duplicating that would be waste;
recall is the gap, and recall is the number a node/edge graph claims to move.

## The two tiers

Ten questions, five expected precedents, each asked twice:

- **`artifact-named`** — phrased the way a self-fix spec usually is, naming the
  file or symbol. This is the **control**. If it fails, the harness is broken,
  not readback.
- **`reworded`** — the identical defect in a builder's own words, with artifact
  names and distinctive identifiers removed. This is the **hypothesis**: it is
  the case an `entry -touches-> file` edge would answer and token matching cannot.

Scoring the same targets both ways is what isolates the mechanism. The delta
between the tiers is precisely "the spec named the artifact."

## Adding questions

Keep the pairing. A new question needs an expected `eid` that exists in the
corpus you score against — `score.js` reports any question whose target is absent
as a **broken question** and excludes it from scoring rather than counting it as
a recall failure, because an eval that silently scores its own bookkeeping errors
is worse than no eval.

Frozen results and the method behind them: [BASELINE.md](BASELINE.md).
