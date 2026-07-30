# Design: text-as-truth (event-sourcing) for shared-write memory

> **Historical record.** QMD (the `@tobilu/qmd` semantic search index) was removed from pebbl in M2. SQLite FTS5/BM25 is now the only search engine. This note predates that change and is kept as a design/decision record; its QMD references describe how pebbl worked at the time, not current behavior.

*Invert Pebbl's canonical store from binary `db.sqlite` to a committed append-only `events.jsonl`, so memory lives in git and multiple contributors add learnings that merge. SQLite + qmd demoted to rebuildable local indexes. Status: designed + adversarially verified, P0 tracer queued to the factory. June 17, 2026.*

Decision: **build tracer first.** Effort: ~18-26 engineering days across P0-P6. Adversarial verdict: the inversion is genuinely required (the cheap "harden the publish model" path provably cannot deliver cross-actor correction or concurrent compaction) and survived refutation; four naive sub-claims were killed and their fixes are baked in below.

---

## Why

Ashley wants project memory in git so contributors and her own machines add to a shared store, and those additions must merge without conflict or data loss. Impossible today by construction: the canonical store is `.pebbl/db.sqlite`, a binary file git can't merge, so it's gitignored and sharing only happens one-directionally through read-only markdown projections + an out-of-band mirror sync.

Shared-**write** can't be hardened onto a mutable binary canon. The committed projection carries no stable id and no `corrects` field (compact.js:125 emits only `cat/topic/tier/source`), so one actor can't point at another's entry to fix it. And compaction does a whole-file `fs.writeFileSync` rewrite (compact.js:114-130) because it DELETEs rows, which is the one guaranteed-conflict operation. The only path to the goal is to make an append-only text log the truth and demote SQLite/qmd to disposable indexes rebuilt by a one-directional fold.

This is the one lens that favors flipping the source of truth. The earlier OKF eval ([eval-okf-2026-06-17.md](./eval-okf-2026-06-17.md)) had interop and migration both saying *don't flip*; collaboration is the reason that overrides them. It also supersedes the publish-only direction of [design-shared-decisions.md](./design-shared-decisions.md) for repos that want shared-write.

## Recommended design

**Canonical format** - `.pebbl/events.jsonl`, one JSON object per line, UTF-8, LF-terminated, never pretty-printed (one event = one line = one diff hunk). The only committed authoritative artifact. `db.sqlite` is renamed `view.sqlite`, gitignored, disposable. Markdown projections (`manual-logs.md`, `handoffs.md`, `narrative.md`, `commit-log.md`) are still regenerated for browsing but are no longer authoritative and no longer the merge substrate.

**Envelope** (every line): `{eid, ts, emitted_at, type, actor, v, ...payload}`. `eid` = global ULID. `ts` = domain-event time (old `logs.timestamp`). `emitted_at` = append time (tie-break). `actor` = `<git-email-short>@<machine>` (the author+source dimension shared-write adds). `v` = envelope schema version.

**IDs** - ULID (Crockford base32, time-sortable, offline-mintable, collision-safe). Chosen over UUIDv4 so `ORDER BY id` recency and the `b.id - a.id` comparator survive as a time proxy; over content-hash so two actors mint ids offline with zero coordination. **FK translation** (the read-side blast-radius win): on the wire relations are eids; in `view.sqlite` a rebuild-time map resolves eids back to LOCAL integers, so `logs.id` stays INTEGER and `parseInt` (log.js:140), `b.id-a.id` (context.js:423), `ORDER BY id`, and the six `id NOT IN (SELECT corrects...)` subqueries keep working unchanged. The integer is a per-machine rebuild artifact; the eid is the only shared identity. Stamp `legacy_id` so old human refs ("see #412") resolve.

**Event model** (closed set, every event a pure append): `append`, `correct` (re-targets the existing `--corrects` path from local int to eid), `supersede` (compaction rollup, `rolls_up:[eid]`), `resolve` (replaces in-place UPDATE at compact.js:292), `expire` (replaces DELETE of fleeting), `commit` (from post-commit hook), `handoff-open`/`handoff-close`, `narrative-set` (upgrades narrative's single `.bak` to full append-history). Nothing is ever deleted or mutated in place.

**Compaction-as-append** (the central inversion) - the destructive transaction (compact.js:275-302: INSERT rollup + DELETE sources + UPDATE/DELETE ambiguous + DELETE expired) becomes a small batch of appended `supersede`/`resolve`/`expire` events. Originals stay in the log forever; the fold hides them because their eid appears in a live supersede's `rolls_up`. The `db.transaction`/rollback contract, the archive-before-transaction dance (compact.js:257-272), and `archive/*.txt` + `archive.md` are deleted - `events.jsonl` IS the durable archive. By policy compaction runs single-writer on the main/release line; the fold dedups overlapping rollups by keeping the lexicographically-smaller supersede eid.

**The fold** - pure `fold(events[]) -> {view.sqlite rows, the 4 markdown files}`, deterministic, sorts by `(ts, emitted_at, eid)` so file order is irrelevant. Same input -> byte-identical output on every machine, which is what makes never-committed markdown safe to regenerate anywhere. NOTE (completeness fix): this is net-new `events -> live-set` reduction, NOT "80% of regenerateMarkdown" (that function is db->md; we reuse only its markdown string tail). The supersession reducer (correct chains, double-correct, rollup-of-rollup) is the bulk of the work and needs property tests, not example tests.

**Rebuild triggers** - lazy staleness check per command (`view.sqlite` stores `folded_through` = last eid + byte offset + a cheap fingerprint; pure-append growth folds only the new tail in ~ms; a changed prefix triggers a full replay, single-digit ms at ~500 events). New post-merge/post-checkout git hooks touch a sentinel; rebuild is lazy on next read, never inside the hook. **qmd is OFF the synchronous path** (killed-verdict fix): inline rebuild touches only `view.sqlite` + markdown; `qmd update`/`qmd embed` (measured 7-9s reindex, ~80s embeddings, inline today) defers to a background/idle job. `pebbl search` uses BM25 so a few-seconds-stale index stays correct. A **per-store lockfile** (pebbl has none today - no flock, no busy_timeout, no WAL) serializes rebuild against concurrent local writes, closing the shared-checkout race.

**Merge handling** (both killed preconditions enforced - plain git append DOES conflict, and `union` DOES silently corrupt a torn last line; both reproduced):
1. `.pebbl/events.jsonl merge=union` in `.gitattributes` is MANDATORY, installed by init. Without it, two appends after the same last line conflict.
2. Trailing-newline invariant on every appender (open, check last byte is `\n`, prepend if missing, append LF-terminated line) plus a pre-append/fold integrity check that repairs a torn final line BEFORE the next append. Without it, `union` merges a torn line into unparseable mangled JSON, exit 0, no markers.
3. Unique-per-line ULIDs make "take both" always semantically correct. Residual conflicts (concurrent compaction, double-correct) resolve by appending, never editing.

**Per-repo mode** - one universal on-disk format (DRY, no second code path); init decides only whether `events.jsonl` is COMMITTED (shared) or GITIGNORED (local, today's leak-proof behavior). **Default = LOCAL.** Shared is explicit `--shared`. A PUBLIC remote forces local unless `--shared --allow-public-memory` AND a clean full-history scan. Per-repo, never factory-wide.

**Privacy** (load-bearing chosen constraint, hardened to the four killed-verdict fixes - the naive scanner failed all three named leak classes against the live store):
1. Scan in git PRE-COMMIT and PRE-PUSH on every commit, not one-shot at init.
2. Scanner covers the three classes the live store actually leaks: all non-RFC1918 IPs and host:port pairs, credential FILE PATHS (`.env`, `.claude-env`, `/etc/*-bot.env`), and a PII/name denylist seeded from the repo's anon name-map. Token-shape regex alone is insufficient. <!-- allowlist-secret: this line SPECIFIES the cred-path patterns, so it necessarily contains them -->

<!--
This section quotes the very strings the scanner detects, so it used to flag
itself on every run — the fake weapon airport screeners send through the X-ray
to check the operator is awake, reported as a real one. Lines that must quote a
leak example carry `allowlist-secret`; the exemption is line-scoped and
`git grep allowlist-secret` lists every one of them.
-->

3. Foundation tier is PRIVATE-BY-DEFAULT; publishing a foundation entry needs explicit per-entry `--share`.
4. Two-file split: `events.jsonl` (committed, shared only) + `events.local.jsonl` (always gitignored, private); the fold reads both, git transports only the shared file. Honest scope: this materially reduces leak probability; append-only can't forget, so it is not "will not leak." A real leaked secret must be ROTATED, not redacted.

## Phased plan

- **P0 - Tracer (2-3d):** prove clean multi-contributor merge end-to-end. Append helper with the trailing-newline invariant + torn-line repair; init writes the `merge=union` gitattribute; minimal `fold` for `append` events only; `pebbl log` writes an append event + rebuilds the view inline. Scripted two-contributor test: two branches each `pebbl log` after a common base, `git merge`, assert zero conflict markers + valid JSON + fold reads all. **Move the per-store lockfile here, not P4** (completeness fix - it's the safety floor for every later write path).
- **P1 - Full fold + read-side FK translation (3-4d, riskiest):** build the `events -> live-set` reducer from scratch (supersession semantics is the bulk); reuse only the markdown string formatters as the tail. Byte-identical `view.sqlite` rows + the 4 markdown files. eid->local-integer map so the read side is untouched. Property tests. Acceptance: fold-equivalence vs a live `db.sqlite`.
- **P2 - Migrator + per-store FK audit (3-4d):** `pebbl migrate-to-events` (dry-run default, idempotent). Per store, same-snapshot audit+migrate: read `db.sqlite` in `(ts,id)` order, mint time-seeded ULIDs, build oldInt->ULID map FIRST, remap all five FK sites INCLUDING `session_entries`/`session_commits` as first-class per-element-verified arrays (178 integers in sw-factory, one handoff refs 75 - NOT a footnote), AND the 143-row `commits` table -> `commit` events (completeness fix). Pre-migration audit asserts every FK integer resolves to a surviving row; abort the store on any orphan. `db.sqlite` -> `legacy-db.sqlite` rollback artifact. Committed markdown is explicitly LOSSY (no `session_entries`), so db is the rollback source, never markdown (matters for lumr, which commits only handoffs.md).
- **P3 - Compaction-as-append (2-3d):** replace the transaction with appended `supersede`/`resolve`/`expire`; delete archive machinery + rollback contract; fold dedup for overlapping rollups; compaction-on-release guardrail. Net deletes more code than it adds.
- **P4 - Rebuild triggers + qmd off hot path + locking (2-3d):** lazy staleness, post-merge/post-checkout hooks, `pebbl rebuild`, defer qmd to background. (Lock moved to P0.)
- **P5 - Privacy (3-4d):** pre-commit/pre-push scanner (3 real classes), foundation private-by-default + `--share`, two-file split, public-repo hard gate. **First deliverable: a one-time `pebbl audit-history`** (completeness fix - see Precondition below).
- **P6 - Fleet cutover (2-3d + ~1wk soak/wave):** private throwaway tracer, then sw-factory, then the rest. Format is per-store so migrated + legacy coexist (path picked by presence of `events.jsonl`).

## Precondition (present security finding, not part of the build)

The leak is **already in committed git history.** sw-factory's tracked `manual-logs.md` (174 commits, put there by `52d7cb2` "Track pebbl markdown history") contains: droplet public IP+port `67.207.93.196:48422` (11 lines), the `sk-ant-oat01-` OAuth token shape, and credential paths `/root/.claude-env`, `/etc/factory-updates-bot.env`, `/etc/bookforge-bot.env`, `/factory/etc/sw-factory-bot.env`. <!-- allowlist-secret: naming the already-published leak IS this section's subject --> P5's forward gate scans new pushes, not existing history. Before any store is eligible for `--shared`, run `pebbl audit-history` over all committed `.md` history and produce a rotation checklist. The droplet IP and bot.env paths need a rotate-vs-accept decision independent of this project.

**Resolved 2026-07-30.** The rotate-vs-accept decision above is now recorded, not just prompted for. `audit-history` writes accepted findings to `.pebbl-audit-accepted.json` (committed, fails closed) and the pre-push gate blocks only on UNACCEPTED ones. This closes a deadlock the original design missed: a finding inside an already-pushed commit can never be scrubbed without rewriting public history, so the hard gate blocked every subsequent push and the only exit was `PEBBL_SKIP_SCAN` — a gate you must skip every time is one you have already stopped reading. Status of these specific findings: the droplet host:port was verified dead (port closed, host up with SSH), and the credential entries are file PATHS rather than credentials, so both are ACCEPTED with that reason. The `sk-ant-oat01-` reference is a token SHAPE, not a value.

## Resolved decisions (Ashley, 2026-06-17)

1. **(Q1=A)** Migrate the 36 free-text `correction` entries as plain `append` events - lossless vs today's actual behavior; no heuristic linking. Hand-link only a specific one if it ever matters.
2. **(Q2=A)** Compaction-on-release is a SOFT policy: a `doctor` warning, not a hard interlock. The fold dedups overlapping rollups, so this guards "ugly," not "broken." Harden later only if duplicate rollups actually appear in practice.
3. **(Q3=B)** Foundation private-by-default applies ONLY to public repos. On private repos foundation shares freely (the repo is already the trust boundary); per-entry `--share` discipline is reserved for public remotes. Requires reliable public/private detection + re-check on visibility flips (P5 owns this).
4. **(Q4=B)** Keep BOTH the cross-machine mirror and git-as-transport during rollout; collapse to git-only per-store as each store goes shared. eids dedup double-delivery in the fold, so running both is safe. Mirror retirement is the eventual end-state, not a flag day.
5. **(Q5=A)** Run the P0 tracer on a private throwaway repo; sw-factory is the first REAL cutover (P6), not the tracer target.

## Escalation protocol (all phases)

If a builder hits a decision this design doesn't settle: do NOT guess and do NOT stall. First resolve it by spawning a sub-agent to research the code/options. If it STILL needs a human judgment call, write a `pebbl handoff` in this repo with a `blocked:` item stating the decision and a recommended default, then proceed with that default only where safe - otherwise stop at that boundary. Never block silently.

## Risks

- **Killer (structural):** append-only + any public exposure is a one-way leak amplifier; a secret committed once is in every clone/fork forever and can only be hidden from the live view, never deleted. The live stores already contain exactly this. Public is a HARD gate, foundation is private-by-default, real leaks require rotation.
- Migration fidelity on `session_entries` (178 refs); first-class per-element verify with loud abort.
- Determinism of the fold (sort stability, topic CSV re-join, timestamp ties) - if it isn't byte-identical across machines the never-committed-markdown safety evaporates. Property tests, not example tests.
- qmd 7-9s reindex must truly leave the hot path (P4), or post-pull blocks the next command.
- Fleet is ~5 live stores (sw-factory, security, lumr, harold, terraform-for-law), not the "14" some agents assumed; md-only stores can't migrate losslessly. Inventory before P2.

## Acceptance criteria

- Two contributors `pebbl log` on separate branches from a common base; `git merge` -> exit 0, zero conflict markers, every line valid JSON, fold surfaces both.
- Torn last line + concurrent append does not silently corrupt (integrity check repairs first).
- `fold(events)` byte-identical on two machines (view rows + all 4 md files).
- Migration lossless per store incl. every `session_entries`/`session_commits` integer resolving; aborts on any orphan.
- Read parity: post-migration `pebbl context`/`search` return the same entries + supersession hiding + recency order.
- Compaction creates zero git deletions (append-only supersede/resolve/expire; originals remain; live view hides the right set).
- Privacy gate refuses to commit/push a shared entry with a non-RFC1918 IP+port, a credential file path, or a denylisted name; foundation not shared without `--share`; public push hard-blocks until a clean full-history scan.
- qmd off the synchronous path; per-store lock prevents rebuild/append interleave.
- `pebbl init` on a public-remote repo defaults to LOCAL.

## Provenance

Two adversarial workflows (`wf_fb784de8` OKF eval, `wf_944fd126` this design): 3 competing inversions (events.jsonl / markdown-per-entry / sync-sidecar), judged on five axes, 5 load-bearing claims stress-tested (4 killed with fixes, "worth doing vs hardening" survived high-confidence), synthesized, then a completeness critic (8 gaps, folded in above). Honors the standing constraints from [eval-okf-2026-06-17.md](./eval-okf-2026-06-17.md): SQLite stays the local engine even when demoted from truth; rebuild is one-directional; privacy is a chosen constraint, not an afterthought.
