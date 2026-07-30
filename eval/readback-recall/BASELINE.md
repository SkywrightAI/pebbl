# readback recall — frozen baseline

> **Superseded for the artifact-named tier by the rollup fix.** Rollup rows are
> now excluded from readback's precedent set. Re-scored on the *identical*
> snapshot at `--top 50`:
>
> | tier | recall@1 | recall@5 | MRR |
> |---|---|---|---|
> | artifact-named | 0.20 → **1.00** | 1.00 → 1.00 | 0.533 → **1.000** |
> | reworded | 0.00 → 0.00 | 0.00 → **0.20** | 0.054 → 0.095 |
>
> Every artifact-named query now returns its exact target at rank 1. The reworded
> tier improved only marginally (ranks 44→37, 9→5, 17→12, 11→6, one still never
> found), which is the point: **rollups were the whole artifact-named problem and
> almost none of the reworded one.** Reworded recall@5 = 0.20 is the number R1/R2
> now has to beat.
>
> Everything below is the original pre-fix measurement, kept as the record.


Measured 2026-07-30 against a snapshot of `~/loom/.pebbl` taken immediately after
R4 landed (so the duplicate-heavy pre-R4 corpus can't flatter a later
comparison). Corpus: **261 rows** (257 reasoning).

Score at **`--top 50`**. See "Why top=50" below — at `top=10` the reworded tier's
hits sit on the cutoff and flip between runs.

## Result

| tier | n | recall@1 | recall@5 | MRR | target ranks |
|---|---|---|---|---|---|
| artifact-named | 5 | 0.20 | **1.00** | 0.533 | 2, 2, 3, 1, 3 |
| reworded | 5 | 0.00 | **0.00** | 0.054 | 44, 10, **never**, 17, 11 |

Both tiers are stable across `--top 50` and `--top 100`. The artifact-named
numbers are identical at every cutoff from 10 up.

All ten expected precedents are **present** in the corpus — none was folded away
by compaction — so every failure is a ranking failure, not a missing target. No
broken questions.

## Finding 1 — rewording a spec drops recall to zero

Same defect, same target, different words: recall@5 goes **1.00 → 0.00**.

Not "lower" — zero, at every cutoff tried. The reworded targets land at ranks 44,
10, 17 and 11, and **B3 is never retrieved at all**, not in the top 100 of a
261-row corpus. A precedent at rank 17 is not found in any practical sense; the
collision check reads the top handful.

Readback finds prior work when the spec reuses its vocabulary and stops finding
it otherwise. That is the token-matching ceiling as a number, and it is what a
node/edge layer exists to answer — a spec that names no file still resolves to
one through `entry -touches-> file`.

## Finding 2 — compaction rollups dominate retrieval

Unexpected, and larger than Finding 1 in the near term.

**8 of 10 queries return a compaction rollup at rank 1.** Rollups are 5 of 261
rows (1.9%) and run 25k / 30k / 37k / 114k / **185k** characters against a
**1,034-character median entry** — up to 179x. A row holding a quarter's
accumulated text shares tokens with nearly any query, so bm25 puts it first and
buries the specific precedent readback exists to surface.

They compound: rollup headers nest on each pass (`steering notes on loom-maintain
(2026-Q3): steering notes on loom-maintain (2026-Q3): ...`), so the rows grow
every compaction cycle.

### The counterfactual

Re-scored on a corpus with the 20 rollup-producing `supersede` events removed
(796 rows, 591 reasoning — a *larger* haystack):

| tier | live recall@1 | un-compacted recall@1 | live MRR | un-compacted MRR |
|---|---|---|---|---|
| artifact-named | 0.20 | **1.00** | 0.533 | **1.000** |
| reworded | 0.00 | 0.00 | 0.042 | 0.060 |

Without rollups, **every** artifact-named query returns its exact target at rank
1 — perfect on the control tier — and the rank-1 slots fill with varied real
entries instead of the same two rollups. Recall improved on a corpus three times
larger, which rules out "fewer rows, easier task."

**The two findings are independent**, which is what makes the baseline useful:
compaction explains the entire artifact-named ranking loss and **none** of the
reworded loss. Removing rollups moves reworded recall@5 by nothing. So the graph
hypothesis survives its own eval — the reworded failure is the genuine
token-matching ceiling, not a compaction artifact.

## Why top=50

At `top=10` the reworded hits sit at ranks 9–11, right on the cutoff, so a single
new entry in the store flips a hit to a MISS and the tier's MRR wobbles between
0.02 and 0.05. Scoring deeper measures the rank instead of truncating it. The
finding is unchanged either way — recall@5 is 0.00 at every cutoff — but the
number is reproducible.

This also means the live store is a moving target: other sessions write to
`~/loom/.pebbl` continuously. Score a snapshot, and record `corpus_rows` (the
harness prints it on every run) with any number you compare against.

## Caveat on the counterfactual

Dropping the rollup `supersede` events also un-hides the entries those rollups
replaced, so this models "a corpus that was never compacted" rather than
"readback ignores rollup rows." Both effects push the same way and the mechanism
is directly confirmed (rollups occupy rank 1 before and are absent after), but a
readback-side row filter would isolate it exactly. That change is not made here:
loom's collision gate is being actively worked in another session, and altering
readback ranking underneath it would collide.

## Re-running after a storage change

Score the same question set, on a snapshot, at the same `--top`. Report the
corpus size alongside — a recall number is only comparable against a comparable
corpus.
