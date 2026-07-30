# memory-archive

Frozen pebbl memory from before the event-sourcing rewrite. Read-only history —
nothing here is written to again.

## `2026-05_2026-07/`

pebbl's first two months of memory (~125 entries, 2026-05-23 → 2026-07-02),
rescued after the live store was cut over. The live store in `../.pebbl/`
starts 2026-07-12, so without this the project's first two months are simply
gone.

**Why `db.sqlite` is committed here when the live store's is not.** They are not
the same kind of file. In the live store, `events.jsonl` is the source of truth
and the sqlite is a projection rebuilt on every read — committing it would store
the same fact twice and hand git a binary it cannot merge. This archive predates
event sourcing, so it has no `events.jsonl`: the sqlite *is* the source, and the
markdown beside it is what was derived. It is also frozen, so the usual argument
against committing a binary (constant churn, unmergeable conflicts) does not
apply — it will never change again.

## `plans/`

The V02 fix and implementation plans that drove that era of the rewrite. Kept
for provenance; superseded by the design notes in `../notes/`.
