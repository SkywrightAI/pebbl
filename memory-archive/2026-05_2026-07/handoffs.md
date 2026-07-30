# Handoffs

## 2026-05-27T04:29:45.029Z - handoff #1: add docs field to handoffs for external reference tracking
<!-- handoff:1 field:summary topic:handoff,schema status:closed -->

## 2026-05-27T04:29:45.029Z - handoff #1 done: designed schema, confirmed no overlap with narrative refs, confirmed drift detection stays separate
<!-- handoff:1 field:done topic:handoff,schema status:closed -->

## 2026-05-27T04:29:45.029Z - handoff #1 todo: migrate v0.3->v0.4 with docs TEXT column
<!-- handoff:1 field:todo topic:handoff,schema status:closed -->

## 2026-05-27T04:29:45.029Z - handoff #1 todo: add --docs flag on creation
<!-- handoff:1 field:todo topic:handoff,schema status:closed -->

## 2026-05-27T04:29:45.029Z - handoff #1 todo: update displayHandoff to stat local paths and sort by mtime
<!-- handoff:1 field:todo topic:handoff,schema status:closed -->

## 2026-05-27T04:28:01.949Z - handoff #2: test docs feature
<!-- handoff:2 field:summary topic:handoff status:closed -->

## 2026-05-27T04:28:01.949Z - handoff #2 done: migration, display
<!-- handoff:2 field:done topic:handoff status:closed -->

## 2026-05-27T04:28:01.949Z - handoff #2 todo: tests
<!-- handoff:2 field:todo topic:handoff status:closed -->

## 2026-05-27T14:42:18.441Z - handoff #3: ready to start Phase 0: smallest A/B test validating that lessons in pebbl actually change agent behavior. Test bed is pebbl-eval which has a strong logged decision (markdown for storage). If P0 passes proceed to P1 attribution work; if no signal stop and reconsider before building any infrastructure
<!-- handoff:3 field:summary topic:eval status:open -->

## 2026-05-27T14:42:18.441Z - handoff #3 todo: pick task in pebbl-eval that depends on the logged markdown-storage decision
<!-- handoff:3 field:todo topic:eval status:open -->

## 2026-05-27T14:42:18.441Z - handoff #3 todo: construct a task that would tempt a naive agent toward SQLite instead
<!-- handoff:3 field:todo topic:eval status:open -->

## 2026-05-27T14:42:18.441Z - handoff #3 todo: wire up parallel agent spawning - one with pebbl context injected at start, one without
<!-- handoff:3 field:todo topic:eval status:open -->

## 2026-05-27T14:42:18.441Z - handoff #3 todo: run 3-5 trials per condition
<!-- handoff:3 field:todo topic:eval status:open -->

## 2026-05-27T14:42:18.441Z - handoff #3 todo: score binary did each follow the decision
<!-- handoff:3 field:todo topic:eval status:open -->

## 2026-05-27T14:42:18.441Z - handoff #3 todo: document the delta
<!-- handoff:3 field:todo topic:eval status:open -->

## 2026-05-27T14:42:47.988Z - handoff #4: [session] designed pebbl's self-improvement strategy through architectural discussion. Established two-types-of-evals distinction (evals ON pebbl vs evals VIA pebbl), mapped L1-L5 maturity ladder to pebbl architecture with L2 as logical ceiling, ran three-architect analysis on merge-vs-separate, synthesized empiricist-sequenced 4-phase plan, logged as foundation entry, created handoff #3 for Phase 0 operational pickup
<!-- handoff:4 field:summary topic:eval,future status:open -->

## 2026-05-27T14:42:47.988Z - handoff #4 done: two-types eval distinction logged
<!-- handoff:4 field:done topic:eval,future status:open -->

## 2026-05-27T14:42:47.988Z - handoff #4 done: L1-L5 ladder logged with pebbl ceiling at L2
<!-- handoff:4 field:done topic:eval,future status:open -->

## 2026-05-27T14:42:47.988Z - handoff #4 done: bias/Goodhart adversarial concerns logged
<!-- handoff:4 field:done topic:eval,future status:open -->

## 2026-05-27T14:42:47.988Z - handoff #4 done: three-architect synthesis pointed at make-pebbl-loud direction
<!-- handoff:4 field:done topic:eval,future status:open -->

## 2026-05-27T14:42:47.988Z - handoff #4 done: 4-phase plan logged as foundation
<!-- handoff:4 field:done topic:eval,future status:open -->

## 2026-05-27T14:42:47.988Z - handoff #4 done: handoff #3 created for Phase 0
<!-- handoff:4 field:done topic:eval,future status:open -->

## 2026-05-27T14:42:47.988Z - handoff #4 todo: execute Phase 0 per handoff #3
<!-- handoff:4 field:todo topic:eval,future status:open -->

## 2026-05-27T14:42:47.988Z - handoff #4 todo: revisit merge-vs-separate question only if P0 produces signal
<!-- handoff:4 field:todo topic:eval,future status:open -->

## 2026-05-27T14:42:47.988Z - handoff #4 todo: do not start P1 infrastructure work until P0 validates that lessons transfer
<!-- handoff:4 field:todo topic:eval,future status:open -->

## 2026-05-27T14:42:47.988Z - handoff #4 blocked: all downstream work blocked on Phase 0 result - intentional empiricist gate
<!-- handoff:4 field:blocked topic:eval,future status:open -->

## 2026-05-31T08:20:44.149Z - handoff #5: list
<!-- handoff:5 field:summary topic: status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6: handoffs no longer flatten — store stays structured, materialize at item granularity
<!-- handoff:6 field:summary topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: handoff.js --close stops promoting flattened blob to logs
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: materializeHandoffsMd helper writes one ##-block per
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: -split item to handoffs.md
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: splitItems and checkFieldQuality helpers exported
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: write-time guard warns on long fields with no separators
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: search.js parseQmdResults handles <!-- handoff:N field:X --> blocks
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: dedupeResults suppresses handoff items that duplicate a log entry
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: searchHandoffsSqlite fallback scans handoff fields when qmd absent
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: searchSqlite excludes tier=archived
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: context.js gained compact RECENT HANDOFFS section
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: 30 new tests pass
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: AGENTS.md documents
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: -separated atomic items
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: lumr cleanup archived 5 promoted blob rows (86,114,125,127,128) and re-materialized handoffs.md (74 item-blocks)
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: open handoffs now materialize too with status:open tag (create+close both call materializeHandoffsMd)
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: AGENTS.md sharpened (log gates atomically, not at handoff close)
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: committed all changes as a8897ff
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: lumr backups removed after passing confidence checks
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 done: notes qmd collection left deleted (no path recoverable, 0 files indexed when removed)
<!-- handoff:6 field:done topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 blocked: qmd collection name 'pebbl' is hardcoded so only one project gets indexed (separate spawn_task chip)
<!-- handoff:6 field:blocked topic:handoffs,search,context,retrieval status:closed -->

## 2026-05-31T08:44:10.718Z - handoff #6 blocked: test/migrate.test.js has 3 pre-existing failures (handoffs table missing on raw v0.1 db, harness bug not mine)
<!-- handoff:6 field:blocked topic:handoffs,search,context,retrieval status:closed -->

## 2026-06-10T23:34:40.000Z - handoff #7: --help
<!-- handoff:7 field:summary topic: status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8: Refactored AGENTS.md/PEBBL.md system; audit surfaced CLI-affordance bugs that should be the next focus
<!-- handoff:8 field:summary topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 done: renamed CHEATSHEET.md to PEBBL.md (uppercase, tool-namespaced for agent discovery)
<!-- handoff:8 field:done topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 done: slimmed AGENT_SECTION in src/init.js from 113 to 16 lines (behavior triggers only, points to PEBBL.md)
<!-- handoff:8 field:done topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 done: switched AGENTS.md pebbl-block to HTML sentinel markers <!-- pebbl:begin/end --> for robust upgrade/eject surgery
<!-- handoff:8 field:done topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 done: upgrade.js auto-migrates old-format header blocks
<!-- handoff:8 field:done topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 done: init now writes tool-managed PEBBL.md at project root, overwritten on init/upgrade with a 'do not edit' notice
<!-- handoff:8 field:done topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 done: pebbl-eval verified end-to-end (113 → 20 line AGENTS.md, PEBBL.md materialized, idempotent upgrade)
<!-- handoff:8 field:done topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 done: rewrote PEBBL.md as a dense agent reference (178 → 90 lines, dropped tutorial recipes, kept category/tier semantics)
<!-- handoff:8 field:done topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 done: cascaded wording edit 'if you complete its work' through source and downstream
<!-- handoff:8 field:done topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 todo: fix --help bug: 'pebbl log --help' logs an entry with message '--help' instead of printing help
<!-- handoff:8 field:todo topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 todo: 'pebbl handoff --help' creates a handoff with summary '--help' — argument parser must short-circuit --help before dispatch
<!-- handoff:8 field:todo topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 todo: add per-subcommand --help that prints categories and tiers inline, not just flag lists
<!-- handoff:8 field:todo topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 todo: teach in errors: 'pebbl log msg' with no --cat should refuse or loud-warn with the category list (currently silent-accepts as 'uncategorized')
<!-- handoff:8 field:todo topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 todo: consider 'pebbl help <topic>' command for categories/tiers/compaction/file-layout
<!-- handoff:8 field:todo topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 todo: once CLI help is rich enough, decide whether PEBBL.md shrinks to file-layout only or disappears entirely
<!-- handoff:8 field:todo topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 todo: add test coverage for init/upgrade/eject — the AGENTS.md sentinel-block surgery is currently verified by manual tempdir smoke tests only (test/init.test.js, test/upgrade.test.js, test/eject.test.js)
<!-- handoff:8 field:todo topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-02T13:22:38.987Z - handoff #8 todo: pre-existing test/migrate.test.js failure (no such table: handoffs) is unrelated to this work but worth fixing
<!-- handoff:8 field:todo topic:agents-md,cli-affordances,init,upgrade status:closed -->

## 2026-06-15T15:40:22.421Z - handoff #9: pebbl recall gap + agreed fix: decisions buried in a repo's sources/*.md are invisible to pebbl search because qmd indexes only .pebbl/ projections. Design: index source docs as a READ-ONLY discovery surface tagged [source], ranked BELOW curated entries, with NO tier and NO compaction, so pebbl stays distilled memory and just gains a finding-aid. Precedent already in pebbl: commit-log.md and mirror/ index non-curated material for discovery. Queued to the factory as pebbl--pebbl-sources-index.
<!-- handoff:9 field:summary topic:sources-index status:open -->

## 2026-06-15T15:40:22.421Z - handoff #9 done: design agreed: read-only [source] discovery surface, not memory entries
<!-- handoff:9 field:done topic:sources-index status:open -->

## 2026-06-15T15:40:22.421Z - handoff #9 done: ranked below curated
<!-- handoff:9 field:done topic:sources-index status:open -->

## 2026-06-15T15:40:22.421Z - handoff #9 todo: add config for source dirs to index
<!-- handoff:9 field:todo topic:sources-index status:open -->

## 2026-06-15T15:40:22.421Z - handoff #9 todo: qmd-index them tagged [source]
<!-- handoff:9 field:todo topic:sources-index status:open -->

## 2026-06-15T15:40:22.421Z - handoff #9 todo: rank source hits below curated entries
<!-- handoff:9 field:todo topic:sources-index status:open -->

## 2026-06-15T15:40:22.421Z - handoff #9 todo: re-index from disk so deletes drop out
<!-- handoff:9 field:todo topic:sources-index status:open -->

## 2026-06-15T15:40:22.421Z - handoff #9 todo: add tests
<!-- handoff:9 field:todo topic:sources-index status:open -->
