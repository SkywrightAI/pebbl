# Manual Logs

## 2026-05-23T16:31:41.873Z - Phase 2: structured logging with --cat --topic --tier --source flags. Validated values live in one place (log.js) and are exported for reuse. log-commit.js now writes to both commits and logs tables.
<!-- cat:decision topic:pebbl tier:detail source:human -->

## 2026-05-23T16:44:10.437Z - Phase 5: compaction uses category/primaryTopic/month grouping with threshold from config.yml. Signal-tier entries never appear in groups. Archive is append-only plain text in .pebbl/archive/YYYY-MM.txt. Transaction ensures rollback on failure. Markdown regenerated from SQLite post-compaction.
<!-- cat:decision topic:pebbl tier:signal source:human -->

## 2026-05-23T16:44:12.351Z - Phase 6: AGENTS.md now includes category table, session-end logging instruction, compaction commands. Eject markers updated to match new content. displayEntry() extracted to log.js to eliminate duplication across search.js and context.js.
<!-- cat:decision topic:pebbl tier:signal source:human -->

## 2026-05-23T18:10:33.321Z - 6 categories (decision/structure/pattern/data/integration/quality) collapsed from 9 via ADR+arc42+ISO 42010 research — constraint+risk merged into decision, infra dropped for coding agents
<!-- cat:decision topic:taxonomy tier:detail source:human -->

## 2026-05-23T18:10:37.557Z - three-tier entry model (signal/detail/fleeting) from Zettelkasten — maps deletion safety to intent: deliberate entries always leave a trace, auto-captured can expire
<!-- cat:decision topic:tiers tier:signal source:human -->

## 2026-05-23T18:10:38.939Z - frequency-triggered compaction, not time-based — arch decisions are low-volume and individually important (never hit a time window), bug fixes are high-volume (compact naturally)
<!-- cat:decision topic:compaction tier:signal source:human -->

## 2026-05-23T18:10:40.832Z - regex rubric for auto-classification, no AI — working agent (Opus) can't spawn cheaper model, Ollama adds dependency, regex covers 80%+ deterministically, ambiguous 20% handled at compaction review
<!-- cat:decision topic:rubric tier:signal source:human -->

## 2026-05-23T18:10:42.473Z - SQLite is single source of truth, markdown is materialized view for QMD indexing — not a DRY violation, it's a cache. PP DRY applies to logic and decisions, not to caches
<!-- cat:decision topic:storage tier:signal source:human -->

## 2026-05-23T18:10:46.591Z - relates_to and corrects columns ship in v0.2 unused — two nullable INTEGER columns, negligible cost, avoids migration when self-learning layer is built later
<!-- cat:decision topic:schema tier:signal source:human -->

## 2026-05-23T18:10:48.960Z - archive is plain text (.pebbl/archive/YYYY-MM.txt), not embedded or indexed — archived entries are historical, only grepped if something went wrong, costs nothing to maintain
<!-- cat:decision topic:compaction tier:signal source:human -->

## 2026-05-23T18:10:50.898Z - no session system hook — Claude Code Stop hooks run shell commands not prompts, can't generate summaries. AGENTS.md guidance tells agents to log at session end instead
<!-- cat:decision topic:session tier:signal source:human -->

## 2026-05-23T18:10:52.924Z - compaction is archive-to-disk-first then SQLite transaction — on failure, archive has harmless extra lines but SQLite rolls back cleanly
<!-- cat:decision topic:compaction tier:signal source:human -->

## 2026-05-23T18:10:58.445Z - v0.1→v0.2 migration must seed rubric.yml and config.yml, not just alter SQLite schema — discovered via eval when auto-classification silently did nothing on v0.1 projects
<!-- cat:decision topic:migration tier:signal source:human -->

## 2026-05-23T18:11:00.903Z - ensureProjectFiles() lives in rubric.js and is called by log/search/context/compact — seeds rubric.yml and config.yml if missing, never overwrites existing
<!-- cat:structure topic:migration tier:detail source:human -->

## 2026-05-23T18:11:02.884Z - topicFilter() helper in db.js eliminates 3x duplicated SQL for comma-separated topic matching — returns { clause, params } for query composition
<!-- cat:structure topic:search tier:detail source:human -->

## 2026-05-23T18:11:03.999Z - DEFAULT_RUBRIC and DEFAULT_CONFIG exported from rubric.js as shared constants — init.js and ensureProjectFiles both use same source
<!-- cat:pattern topic:dry tier:detail source:human -->

## 2026-05-23T18:11:08.760Z - standardized on AGENTS.md (not CLAUDE.md) as agent instruction file — cross-agent compatible (Claude, Codex, others), pebbl init injects into AGENTS.md automatically
<!-- cat:decision topic:agents-md tier:signal source:human -->

## 2026-05-23T18:11:11.597Z - AGENTS.md protocol: --cat and --topic are mandatory on every pebbl log call, [session] prefix required for session summaries — eval showed agents skip flags when instructions say 'use pebbl log' without emphasis
<!-- cat:decision topic:agents-md tier:signal source:human -->

## 2026-05-23T18:11:14.523Z - v0.2 implementation handed off to mid-tier model (DeepSeek) via IMPLEMENT_V02.md briefing — two-doc approach: IMPLEMENT_V02.md is full spec, plan file is quick-reference card
<!-- cat:decision topic:process tier:signal source:human -->

## 2026-05-23T18:11:16.821Z - eval harness uses orchestrator+subagent pattern — orchestrator plays user (intent, not implementation), worker builds and uses pebbl, orchestrator scores via SQLite queries
<!-- cat:decision topic:eval tier:signal source:human -->

## 2026-05-23T18:11:18.970Z - QMD package is @tobilu/qmd (not 'qmd'), commands are 'collection add' and 'search' (not 'collection create' or 'query') — burned tokens debugging wrong names
<!-- cat:integration topic:qmd tier:signal source:human -->

## 2026-05-23T18:11:26.756Z - pebbl is a tool, not an agent — inspired by ECC's continuous learning but deliberately simpler. No instincts layer, no performance scoring, no AI in the hot path
<!-- cat:decision topic:architecture tier:signal source:human -->

## 2026-05-23T18:11:28.657Z - self-learning layer planned as future addition on top of pebbl — relates_to and corrects fields are the foundation, pattern matching via tags enables it later
<!-- cat:decision topic:future tier:signal source:human -->

## 2026-05-23T18:11:31.218Z - CommonJS throughout, no build step, zero new dependencies beyond better-sqlite3 — keeps pebbl installable via npm link with no toolchain
<!-- cat:pattern topic:conventions tier:signal source:human -->

## 2026-05-23T18:11:32.601Z - tests use node:test runner (built-in, zero dependencies) — test files follow test/<module>.test.js convention
<!-- cat:pattern topic:testing tier:signal source:human -->

## 2026-05-23T18:14:04.204Z - v0.2 implementation designed for handoff to any mid-tier model via IMPLEMENT_V02.md briefing — agent-agnostic, two-doc approach: IMPLEMENT_V02.md is full spec, plan file is quick-reference card
<!-- cat:decision topic:process tier:signal source:human -->

## 2026-05-23T18:26:32.088Z - eval results: 18/21 initial, 3 failures traced to AGENTS.md protocol gaps (missing emphasis on --cat/--topic, undocumented [session] format). After protocol fix: 3/3 retest pass, 4/4 on new during-work logging test. Protocol validated end-to-end.
<!-- cat:quality topic:eval tier:signal source:human -->

## 2026-05-23T18:27:25.710Z - AGENTS.md wording matters: agents skip --cat/--topic when instructions say 'use pebbl log' without bold emphasis. Must say 'ALWAYS use --cat and --topic' with bold and examples showing all flags
<!-- cat:decision topic:agents-md tier:signal source:human -->

## 2026-05-23T18:27:26.073Z - agents log session summaries as 'SESSION SUMMARY' unless explicitly told the format is [session] — bracket prefix must be documented as required, not implied
<!-- cat:decision topic:agents-md tier:signal source:human -->

## 2026-05-23T18:27:26.361Z - eval gap: first test only checked whether entries exist and flags are used, didn't check whether decisions are logged during work vs only at session end — added separate test for during-work logging
<!-- cat:quality topic:eval tier:signal source:human -->

## 2026-05-23T18:27:26.626Z - eval pattern: small focused retests (1 feature, 3-4 scoring queries) are faster and more diagnostic than full 21-test suite — use full suite for baseline, targeted tests for fixes
<!-- cat:pattern topic:eval tier:signal source:human -->

## 2026-05-23T22:56:03.049Z - named the tool Pebbl - each commit and decision is a small stone that stacks over time into navigable project memory
<!-- cat:decision topic:naming,vision tier:signal source:human -->

## 2026-05-23T22:56:03.382Z - chose CLI as the agent interface - agents are well trained on CLI commands, cleaner than MCP or REST for this use case
<!-- cat:decision topic:architecture,interface tier:signal source:human -->

## 2026-05-23T22:56:03.626Z - chose SQLite + sqlite-vec as storage - single file, no server, no external dependencies, handles semantic search natively, right scale for project-scoped memory
<!-- cat:decision topic:storage,search tier:signal source:human -->

## 2026-05-23T22:56:03.851Z - chose QMD as the search layer - hybrid BM25 plus semantic search, markdown-native, fully local, CLI-native interface, no infrastructure overhead
<!-- cat:decision topic:search tier:signal source:human -->

## 2026-05-23T22:56:04.071Z - scoped memory to single repo only - project context doesn't benefit from cross-project search, each repo controls its own context
<!-- cat:decision topic:architecture,scope tier:signal source:human -->

## 2026-05-23T22:56:04.295Z - git hook auto-captures commits - removes manual burden, captures what changed and which files without extra steps
<!-- cat:decision topic:git,automation tier:signal source:human -->

## 2026-05-23T22:56:04.519Z - manual pebbl log command for decisions and failures - git commits don't capture reasoning, this fills that gap
<!-- cat:decision topic:interface tier:signal source:human -->

## 2026-05-23T22:56:04.744Z - memory files are gitignored - memory is local only, not shared, each developer maintains their own context layer
<!-- cat:decision topic:storage,git tier:signal source:human -->

## 2026-05-23T22:56:04.967Z - chose markdown as the storage format for logs - human readable, QMD indexes it natively, agent can read raw files if needed
<!-- cat:decision topic:storage tier:signal source:human -->

## 2026-05-23T22:56:05.191Z - rejected daemon/background process approach - unnecessary complexity, on-demand reads and writes via CLI is sufficient
<!-- cat:decision topic:architecture tier:signal source:human -->

## 2026-05-23T22:56:05.412Z - rejected cross-project memory - projects are self-contained contexts, querying across repos adds noise not signal
<!-- cat:decision topic:scope,architecture tier:signal source:human -->

## 2026-05-23T23:05:22.995Z - context output orders by tier priority (signal→detail→fleeting) then recency, not just recency — ensures permanent architectural decisions always surface within the 10-entry limit regardless of when they were logged
<!-- cat:decision topic:context,tiers tier:signal source:human -->

## 2026-05-24T21:45:24.303Z - migration system uses meta table with schema_version — migrate() checks version, runs migrations sequentially (v0→v1 adds columns, v1→v2 would be next). Each migration sets new version. SCHEMA always creates latest structure with INSERT OR IGNORE for current version. To add a migration: add if(version<N){migrate_v(N-1)_to_vN(db);setVersion(db,N)} in migrate.js and bump the INSERT OR IGNORE version in SCHEMA
<!-- cat:decision topic:architecture,migration tier:detail source:human -->

## 2026-05-24T22:00:45.374Z - package.json version must track schema version — bump package.json whenever a new migration step is added so the installable CLI version matches the schema it expects
<!-- cat:pattern topic:migration,versioning tier:detail source:human -->

## 2026-05-24T22:01:01.564Z - schema version naming uses minor versions (v0.1, v0.2, v0.3...) not integers — the original convention predated the meta table system; switching to v0/v1 created drift with IMPLEMENT_V02.md and FIXES_V02.md
<!-- cat:decision topic:migration,versioning tier:detail source:human -->

## 2026-05-24T22:08:43.289Z - added rubric rule to auto-tag specification-style decision entries as fleeting — catches entries with config keywords (default, threshold, weight, score, blend, config, param, formula) adjacent to numbers without rationale. The rule uses positional matching (keyword near number) since negative lookahead isn't available in rubric regex; well-written entries with 'because' and narrative structure typically place numbers before keywords, avoiding false positives
<!-- cat:decision topic:rubric,quality tier:detail source:human -->

## 2026-05-24T22:08:45.859Z - AGENTS.md now includes entry quality section with bad vs good examples — the bad example shows a 'spec sheet' entry (threshold is 0.5, weight is 0.6, formula) that lacks rationale; the good example includes 'because' and the Professional Services edge case. Rule of thumb: if it reads like config docs, you forgot the WHY
<!-- cat:pattern topic:conventions,rubric tier:detail source:human -->

## 2026-05-24T22:08:48.188Z - added pebbl upgrade command — updates AGENTS.md pebbl section (replaces old version), appends new rubric rules without overwriting user customizations, refreshes git hook and QMD collection, runs database migration. Unlike init which skips-if-exists, upgrade is idempotent and additive
<!-- cat:decision topic:upgrade,cli tier:detail source:human -->

## 2026-05-24T22:08:50.452Z - [session] built versioned migration system (v0.1→v0.2), added pebbl upgrade command, strengthened entry quality guidelines in AGENTS.md with bad/good examples, added rubric rule to auto-detect spec-dump entries as fleeting
<!-- cat:decision topic:architecture,quality,cli tier:fleeting source:agent -->

## 2026-05-24T22:13:21.678Z - rubric spec-dump rule changed from fleeting→detail tier because losing important decisions to compaction is worse than keeping thin entries — the AGENTS.md education is the primary defense; the rule is a nudge not a gate
<!-- cat:decision topic:rubric,quality tier:detail source:human -->

## 2026-05-24T22:35:08.119Z - threshold is 0.5, weight is 0.6, score is W*fit + (1-W)*scorecard
<!-- cat:uncategorized topic: tier:detail source:human -->

## 2026-05-24T22:36:05.959Z - threshold is 0.5, weight is 0.6, formula is W*fit + (1-W)*scorecard
<!-- cat:uncategorized topic: tier:detail source:human -->

## 2026-05-24T22:36:36.189Z - added stderr nudge at log time — when a pebbl log entry matches the spec-dump pattern (config keywords near numbers without rationale markers like 'because'), a warning is printed to stderr suggesting the agent add rationale. Does not block the entry, just provides immediate feedback
<!-- cat:decision topic:quality,cli tier:detail source:human -->

## 2026-05-24T22:36:38.793Z - pebbl context now enriches thin entries with related git commits via keyword overlap matching (not timestamp). Uses word extraction + stop-word filtering to match entry keywords against git log messages. Shows a warning label when rationale is missing. Git matching only activates for entries the detect-thin module flags
<!-- cat:decision topic:context,enrichment tier:detail source:human -->

## 2026-05-24T22:36:41.210Z - [session] added spec-dump stderr nudge at log time, context enrichment with git commit matching and thin-entry labels, updated pebbl --help with bad/good examples, tightened spec-dump pattern from keyword:number to keyword..number (within 20 chars) to catch 'threshold is 0.5'
<!-- cat:decision topic:quality,context tier:fleeting source:agent -->

## 2026-05-25T08:36:11.456Z - session entries were miscategorized as decision because AGENTS.md, init.js, and README.md all instructed agents to pass --cat decision on [session] entries, which bypasses the rubric entirely (log.js:65 skips rubric when --cat is provided). Fixed by: (1) removing --cat from all session templates, (2) adding a hard guard in log.js that forces [session] entries to uncategorized/fleeting regardless of --cat flag, (3) reordering test rules so [session] is first to match real rubric order
<!-- cat:decision topic:rubric,session,agents tier:detail source:agent -->

## 2026-05-25T08:53:30.973Z - rubric is now always consulted for tier even when --cat is manual, because agents routinely pass --cat decision without --tier, and the old code skipped the rubric entirely when --cat was present -- causing important architectural decisions to land at detail tier where they could be compacted away. Fallback: decision/structure/pattern categories default to signal tier when rubric has no match
<!-- cat:decision topic:rubric,tiers tier:signal source:agent -->

## 2026-05-25T08:57:29.498Z - anchored rubric [session] pattern with ^ because the unanchored pattern matched [session] mid-text -- causing entries like 'the [session] token expires' to get fleeting tier instead of the expected signal tier for decisions. The log.js guard was already anchored but the rubric pattern was not, so the rubric returned fleeting when consulted for tier assignment
<!-- cat:decision topic:rubric,session tier:fleeting source:agent -->

## 2026-05-25T09:41:06.832Z - --corrects now inherits category and tier from the corrected entry because corrections to decisions are themselves decisions -- without this, agents using 'switched from X to Y' with --corrects would get uncategorized even though they're correcting a decision entry. Inheritance is lowest priority: manual flags > rubric > corrects > category defaults
<!-- cat:decision topic:corrects,classification tier:signal source:agent -->

## 2026-05-25T09:41:12.511Z - context.js now filters out superseded entries because --corrects was a dead field -- it wrote the correction reference to the DB but nothing read it, so both the original and correction appeared side by side. This is the foundation for self-correcting memory: agents can query context, notice stale decisions, and issue corrections that properly supersede them
<!-- cat:decision topic:corrects,context tier:signal source:agent -->

## 2026-05-25T10:39:05.603Z - Added narrative command system — stores a short project description in .pebbl/narrative.md, so agents can understand the project without reading all decision entries. Uses --show, --generate, and direct positional text to set.
<!-- cat:decision topic:narrative,structure tier:component source:agent -->

## 2026-05-25T11:24:07.035Z - chose flat-file markdown with YAML frontmatter for storage because it keeps notes human-readable and editable without any tooling, and avoids introducing SQLite or JSON as a dependency
<!-- cat:decision topic:storage tier:component source:human -->

## 2026-05-25T11:24:08.036Z - filenames use YYYYMMDD-HHmmss-slug.md format so they sort chronologically in the filesystem and avoid collisions on same-titled notes
<!-- cat:uncategorized topic:naming,storage tier:detail source:human -->

## 2026-05-25T11:24:08.965Z - zero external dependencies because the eval spec requires it and a YAML frontmatter parser is trivial to write for the subset of YAML we need (flat key-value pairs)
<!-- cat:integration topic:architecture tier:detail source:human -->

## 2026-05-25T11:56:26.585Z - chose manual argument parsing (no library) because the eval spec prohibits dependencies and the --tag X pattern is simple enough to handle with a few lines of string splitting
<!-- cat:decision topic:cli,commands tier:component source:human -->

## 2026-05-25T11:56:27.514Z - routing commands via a simple object map in bin/lief.js because it keeps the CLI entry point thin and each command handler lives as a named export in commands.js
<!-- cat:uncategorized topic:cli,commands,structure tier:detail source:human -->

## 2026-05-25T11:58:21.940Z - [session] built CLI and command layer for Lief note editor — created bin/lief.js (entry point with command routing) and src/commands.js (10 command handlers using storage.js API). Manual argument parsing because zero dependencies. All verification commands pass: help, add (positional + piped), list, list --tag, show, search, delete, edit, tags.
<!-- cat:uncategorized topic:cli,commands,session tier:fleeting source:human -->

## 2026-05-25T11:59:28.230Z - QMD semantic search integration for lief
<!-- cat:decision topic:search,qmd tier:detail source:human -->

## 2026-05-25T11:59:31.461Z - Actual QMD CLI differs from spec — no qmd index subcommand exists, collection creation uses qmd collection add not create. Adapting to QMD 2.5.2s actual API: collection add for init, qmd update for reindex, search --json for results. File paths in search JSON use qmd:// scheme which we convert to local paths.
<!-- cat:decision topic:search,qmd tier:detail source:human -->

## 2026-05-25T12:01:07.125Z - Built src/search.js with QMD integration. All 6 exports verified working: qmdAvailable, initCollection, indexNote, removeFromIndex, semanticSearch, reindexAll. QMD 2.5.2 API adapted from spec assumptions: collection creation uses add not create, no per-file index command exists so indexNote/removeFromIndex call qmd update, search uses qmd search --json. Fallback keywordSearch uses simple term frequency scoring over frontmatter fields and body. Configurable notesDir via QNOTES_DIR env var or ~/.qnotes/notes default.
<!-- cat:decision topic:search,qmd,integration tier:detail source:human -->

## 2026-05-27T04:28:01.949Z - handoff #2 closed: test docs feature. done: migration, display. remaining: tests
<!-- cat:decision topic:handoff tier:foundation source:agent -->

## 2026-05-27T04:29:41.289Z - added docs field to handoffs: external file/URL references stored as JSON, displayed sorted by mtime so fresh docs surface above stale ones
<!-- cat:decision topic:handoff,schema tier:detail source:human -->

## 2026-05-27T04:29:41.642Z - added --close reminder to pebbl context open handoff banner because agents were not reliably closing handoffs after pickup
<!-- cat:decision topic:handoff,agents-md tier:component source:human -->

## 2026-05-27T04:29:41.898Z - test setupDb schema kept in sync at v0.4 with docs column; added 2 docs tests covering JSON storage and null default
<!-- cat:decision topic:handoff,testing tier:detail source:human -->

## 2026-05-27T04:29:45.029Z - handoff #1 closed: add docs field to handoffs for external reference tracking. done: designed schema, confirmed no overlap with narrative refs, confirmed drift detection stays separate. remaining: migrate v0.3->v0.4 with docs TEXT column; add --docs flag on creation; update displayHandoff to stat local paths and sort by mtime
<!-- cat:decision topic:handoff,schema tier:foundation source:agent -->

## 2026-05-27T14:12:20.036Z - two distinct eval modes for pebbl: (1) evals ON pebbl - does the product work, current EVAL_HARNESS.md approach; (2) evals VIA pebbl - using pebbl as substrate for self-improving agent work on a project. (2) is where self-improving work payoff lives but requires per-project eval definitions and an attribution step from eval failure back to which lesson would have prevented it
<!-- cat:decision topic:eval tier:component source:human -->

## 2026-05-27T14:12:23.291Z - self-improvement maturity ladder for pebbl mapped to RSI research: L1 eval-driven iteration with human acting on failures (current state, manual), L2 auto-write lessons via corrects (matches the May 23 self-learning layer foundation note), L3 STaR-style rationale evaluation, L4 multi-agent guardian, L5 DGM-style self-rewriting prompts/skills. Pebbl architecture cleanly supports L1-L2 without violating its lightweight constraints. L3+ requires sandboxing, alignment checks, human gates - the research itself flags this. Logical ceiling for pebbl-as-product is L2; beyond that needs different architecture
<!-- cat:decision topic:eval,future tier:component source:human -->

## 2026-05-27T14:12:29.937Z - adversarial concern - two-agent eval split (writer + runner) only solves execution bias, not authorship bias. If agent A defines what good looks like, agent B is executing within A's frame. Real independence requires eval CRITERIA sourced from outside the agent loop: human-curated, pre-existing tests, or external project specs. The expensive insight - evals are only as good as their unbiased source of truth, and that source needs provenance tracking (human-decided vs eval-derived) once lessons start writing back to memory, otherwise drift is invisible
<!-- cat:quality topic:eval tier:detail source:human -->

## 2026-05-27T14:12:30.312Z - Goodhart risk if eval failures drive automatic rubric updates: rubric drifts toward optimizing pass rates rather than useful classification. Mitigations needed if going this direction - human gate on rubric mutations, lock eval criteria to a snapshot during rubric scoring, provenance tag on every lesson (source: human|eval|hook). Without these, the May 23 self-learning layer becomes a system that can silently re-define its own success criteria
<!-- cat:quality topic:rubric,eval tier:detail source:human -->

## 2026-05-27T14:42:18.081Z - strategic direction for pebbl self-improvement work: empiricist-sequenced 4-phase plan. P0 validate lessons transfer with smallest A/B test (1-2 days, gates everything). P1 attribution surface so consultations are observable in DB (1-2 weeks). P2 visibility features prioritized by P1 data: conflict detection at log-time, proactive context surfacing, drift warnings (2-3 weeks). P3 production A/B harness with delta scoring as release gate (1 week). Total 6-8 weeks if P0 passes. Excluded from scope: self-modifying rubric (L3+ territory), evals-merged-into-pebbl, LLM judges, per-project frameworks, dashboards. Core commitment: make pebbl loud enough that external evals measure it, do not absorb measurement into pebbl
<!-- cat:decision topic:eval,future tier:foundation source:human -->

## 2026-05-31T08:29:14.935Z - verified qmd chunks per file with line-anchor + context window — splitting handoff fields into per-item ## blocks gives per-item retrieval because the anchor lands on the matching line. proof: search 'aggression slider' against a 4-block file anchored to the matching block; against a single-line 3000-char blob it returned the whole blob. Phase 0 gate of the handoff de-flattening redesign.
<!-- cat:decision topic:handoffs,search,retrieval tier:component source:agent -->

## 2026-05-31T08:36:19.639Z - open handoffs now materialize to handoffs.md too with a status:open tag — both create and close call materializeHandoffsMd + qmdUpdate, so in-progress work is searchable not just findable via pebbl context banner. search renders open items as [handoff #N · OPEN · field]. fixes the gap where an agent who searches first (instead of running context first) would miss WIP.
<!-- cat:decision topic:handoffs,search,retrieval tier:component source:agent -->

## 2026-05-31T08:48:14.492Z - namespaced qmd collection name per project (pebbl-<basename>-<hash>) — the literal name 'pebbl' was global and only one project could win, silently breaking cross-project search. qmdUpdate/qmdQuery now self-heal by ensuring the collection exists on every call, and an existing global 'pebbl' is renamed in place rather than orphaned.
<!-- cat:decision topic:search,retrieval,qmd tier:component source:agent -->

## 2026-05-31T08:49:26.149Z - chose architecture #2 (never flatten, handoffs table stays authority) + #3 (item-level retrieval via per-item ## blocks) over #1 (split done into atomic log rows on close). Rejected #1 because it fixes the producer but recreates duplication — done-items would be recaps of session_entries already in logs. #2 keeps logs decisions-only and handoffs structural; #3 makes content findable. Tradeoff: #2 means done-items aren't in the topic-index, which is intentional — topic-index = standing decisions, not session activity.
<!-- cat:decision topic:handoffs,architecture tier:component source:agent -->

## 2026-05-31T08:49:26.645Z - qmd retrieval unit is FILE + line-anchor + context window, not per ## block. one result per file with a tight snippet when match is specific, wide window when match is diffuse. splitting handoff fields into multiple ## blocks works because the line-anchor lands on the matching item — but it is NOT because qmd chunks per block. relevant if anyone tries to optimize chunking later: the lever is line layout, not block count.
<!-- cat:decision topic:search,qmd,retrieval tier:component source:agent -->

## 2026-05-31T08:49:27.035Z - search dedup rule: when a handoff item near-duplicates a log entry (normalized string match), suppress the handoff item. log entries are atomic authority; handoff items are recaps. also collapse repeated handoff items across handoffs ('handoff #7 done: X' and 'handoff #8 done: X' shown once). prevents the same fact appearing twice in results.
<!-- cat:pattern topic:search tier:component source:agent -->

## 2026-05-31T08:49:27.417Z - producer guard threshold: warn when --done/--todo/--blocked is >280 chars with <2 ';' separators. 280 picked as 'roughly two sentences' — a real atomic item fits, a wall does not. <2 separators catches the wall-of-text case; multi-item fields pass even when long. lives in checkFieldQuality, called on handoff create. non-fatal warning so script-driven creates still work.
<!-- cat:decision topic:handoffs tier:component source:agent -->

## 2026-05-31T08:49:27.779Z - Phase 3 lumr migration approach: archive (tier='archived') not DELETE; scoped one-off manual edit not global auto-migration. archive preserves data and is reversible; pre-deletion ref scan (relates_to, corrects, narrative refs) verified zero references first. one-off scope picked over a 'pebbl migrate-handoffs' CLI because the blast radius of an auto-migration firing across all .pebbl stores wasn't justified for 5 rows in one repo. searchSqlite gained AND tier != 'archived' to keep archived rows out of fallback search.
<!-- cat:decision topic:migration,handoffs tier:component source:agent -->

## 2026-06-02T11:32:16.058Z - future feature - entry-level signal rating as human/agent judgment companion to P1 automated attribution. Command shape: pebbl rate <id> --signal high|noise to capture whether a consulted entry actually helped. P1 attribution captures WHAT was read automatically; rating captures QUALITY of what was read explicitly. Together they drive P2 visibility priority: high-signal entries surface more aggressively, noise-rated entries get suppressed or flagged for compaction/rewording, never-consulted entries flagged as dead weight or discovery problems. Belongs adjacent to P1 in plan sequencing - either extend consultations table with a rating column or add a sibling ratings table. Logical extension not a separate phase
<!-- cat:decision topic:eval,future tier:component source:human -->

## 2026-06-02T12:18:09.659Z - Renamed CHEATSHEET.md to PEBBL.md so agents recognize the reference by tool name on first ls — uppercase tool-namespaced filename matches the AGENTS.md/CLAUDE.md/README.md convention agents already scan for. 'Cheatsheet' read as human-only.
<!-- cat:decision topic:docs,naming tier:component source:agent -->

## 2026-06-02T12:18:10.164Z - Slimmed AGENT_SECTION in src/init.js from 113 lines to 16. Reason: research on 2,500+ repos shows bloated AGENTS.md slightly reduces task success vs no file. New version is behavior triggers only (when to log, when to handoff, WHY rule, one example) and points to PEBBL.md for flag/category semantics. PEBBL.md in turn points to 'pebbl <cmd> --help' for flag listings — single source of truth per layer.
<!-- cat:decision topic:agents-md,init tier:component source:agent -->

## 2026-06-02T12:18:10.609Z - PEBBL.md ships to project root, not .pebbl/. Reason: .pebbl/ is gitignored so a reference inside it wouldn't reach other machines or other agents. Root placement maximizes agent discoverability (visible on first ls) at the cost of one extra root file. File is tool-managed — overwritten on init and upgrade with a 'do not edit' notice.
<!-- cat:decision topic:agents-md,init tier:component source:agent -->

## 2026-06-02T12:18:11.038Z - Switched AGENTS.md pebbl-block markers from header-text matching to HTML sentinels (<!-- pebbl:begin --> / <!-- pebbl:end -->). Reason: upgrade.js previously used the last line of AGENT_SECTION as the end marker, so any content change broke surgical replacement. Sentinels let the block's content evolve freely. upgrade.js auto-migrates old header-format blocks on first run; eject.js handles both formats.
<!-- cat:pattern topic:agents-md,upgrade,eject tier:component source:agent -->

## 2026-06-02T12:18:11.464Z - No test coverage for init/upgrade/eject — this refactor required manual smoke testing in a tempdir to verify the AGENTS.md block surgery. Add test/init.test.js + test/upgrade.test.js + test/eject.test.js covering: fresh init writes both files; upgrade refreshes sentineled block; upgrade migrates old header-format block; eject removes both formats and PEBBL.md.
<!-- cat:quality topic:testing,init,upgrade,eject tier:detail source:agent -->

## 2026-06-02T12:45:41.668Z - --help
<!-- cat:uncategorized topic: tier:detail source:human -->

## 2026-06-02T12:45:42.609Z - test message
<!-- cat:uncategorized topic: tier:detail source:human -->

## 2026-06-02T13:37:05.063Z - PEBBL.md no longer generated in user projects — its content lives in 'pebbl help <topic>' (categories, tiers, compaction, file-layout, entry-ids). Source PEBBL.md remains in pebbl repo root as a human-readable doc; init/upgrade no longer touch user projects' roots, and upgrade removes any legacy PEBBL.md left over from before. Decided because: agents read --help, humans don't browse .pebbl/, and a project-root file polluted the namespace; one source of truth (CLI) avoids drift.
<!-- cat:decision topic:agents-md,help,init,upgrade tier:foundation source:human -->

## 2026-06-02T14:27:39.741Z - switched AGENTS.md pebbl block to sentinel format (<!-- pebbl:begin/end -->) so upgrade can do exact in-place replacement without header scanning — header scan was fragile when user had multiple ## sections
<!-- cat:decision topic:agents,upgrade tier:foundation source:human -->

## 2026-06-02T14:27:46.468Z - added help system (src/help.js) and moved inline help out of bin/pebbl.js — dispatch file stays logic-free, help content is maintainable in one place
<!-- cat:decision topic:help,cli tier:component source:human -->

## 2026-06-02T14:27:47.271Z - v0.4 migration now checks if handoffs table exists before ALTER TABLE — PRAGMA table_info on a non-existent table returns empty, not an error, so the guard was silently broken
<!-- cat:decision topic:migrate tier:component source:human -->

## 2026-06-11T00:15:23.660Z - Promoted main to staging tip (ff, includes reviewed add-test-script merge) and committed the untracked source PEBBL.md per the Jun 2 root-doc decision. Push to origin/main pending Ashley (permission gate). Local plans/ v0.2 docs are superseded leftovers, left for Ashley to delete.
<!-- cat:decision topic:release tier:component source:human -->

