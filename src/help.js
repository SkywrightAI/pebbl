'use strict';

const CATEGORIES = `Categories (--cat):
  decision     a choice with rationale: trade-offs, constraints, failed alternatives
  structure    module boundaries, dependency direction, ownership
  pattern      a convention that applies repeatedly (naming, error shapes, async rules)
  data         schemas, field meanings, formats, storage layout
  integration  external systems, contracts, auth flows, API shapes
  quality      targets, measurements, SLAs, eval results
  steering     course-corrections and guidance: failures, regressions, parked work, friction

Steering entries pair with --corrects <id>: the category records a course-correction
or friction; the flag links it to the entry it supersedes. Use either or both.
(\`correction\` is a deprecated alias for \`steering\`, still accepted on --cat.)

Omitting --cat triggers .pebbl/rubric.yml auto-classification. Prefer explicit --cat.`;

const TIERS = `Tiers (--tier):
  foundation   permanent; never compacted; project-wide truths
  component    kept until threshold; subsystem-level decisions; compacts at 15+ entries on a topic
  detail       kept until threshold; narrow facts; compacts at 10+ entries on a topic
  fleeting     ephemeral; auto-deleted after 30 days

Default tier is 'detail'. --scope foundation promotes to foundation tier in one flag.
Entries that read as parameter dumps (numbers with no "because") auto-demote to detail
regardless of --tier.`;

const TOPICS = {
  categories: CATEGORIES,
  tiers: TIERS,
  compaction: `Compaction:
  pebbl compact --preview              show candidate groups ready for compaction
  pebbl compact --execute              merge them
  pebbl compact --resolve <id:action>  resolve ambiguous entries

--resolve actions:
  foundation   promote the entry to foundation tier
  rollup       merge into a summary entry
  skip         leave as-is

Rules:
  fleeting entries are pruned after 30 days
  foundation entries are always kept
  only run compact when 'pebbl context' flags entries as ready`,
  'file-layout': `File layout (.pebbl/):
  db.sqlite          authoritative store — source of truth
  rubric.yml         auto-classification rules
  config.yml         thresholds, defaults
  manual-logs.md     markdown projection of logs (human-readable)
  commit-log.md      auto-captured git commits (human-readable)
  handoffs.md        materialized handoffs (one block per item)
  narrative.md       project narrative
  archive/           compacted entries
  mirror/<machine>/  other machines' synced memory (read-only — the sync job
                     owns it; context, search, and handoff --list show these
                     entries tagged [machine])

db.sqlite is the source of truth. The .md files are projections — regenerable,
safe to delete (they'll re-materialize on the next pebbl write).`,
  'entry-ids': `Entry IDs:
  Every log entry has an integer ID, printed at log time.
  Find an ID with 'pebbl search' or 'pebbl context'.

  Use IDs with:
    --relates <id>    link this entry to a related one (bidirectional reference)
    --corrects <id>   supersede a prior entry — the old one stays searchable
                      but is marked as corrected
    --resolve <id:action>  (compact) decide what to do with an ambiguous entry`,
};

const SUBCOMMANDS = {
  check: `pebbl check — flag entries that cite files that no longer exist

Scans memory for high-confidence path references (a slash + a known
extension) and reports any entry whose cited file is missing from the repo,
highest-tier and newest first. Report only — never edits or deletes; it
points you at \`--corrects\` so you can supersede a wrong entry yourself.

Flags:
  --deep    also grep the repo for backtick-wrapped symbols (slower, opt-in)
`,
  doctor: `pebbl doctor — report-only memory-health check (memory vs memory)

Surfaces CURRENT beliefs that are probably wrong so you can correct them,
grouped into three dimensions: contradictions (two unlinked current entries on
a shared topic with high term-overlap), staleness (an old entry nothing newer
reinforces — low confidence), and missing artifact (reuses \`check\`). Report
only — never edits; it points you at \`--corrects\`. Conservative and capped by
default; a clean store prints a single reassuring line.

Flags:
  --json    emit candidates as a JSON array (for tooling)
  --all     widen past the conservative caps / thresholds
  --deep    also grep the repo for backtick-wrapped symbols (same as check)
`,
  'scan-commits': `pebbl scan-commits — nudge to log decisions never captured

Scans recent commits for decision-shaped changes (the rubric's decision-verb
patterns) that have NO near-matching entry, and prints a ready-to-edit
\`pebbl log "..." --cat decision\` line for each. NEVER auto-logs — every line
is a suggestion you confirm. Dedupes against existing entries so an
already-logged decision is not re-nudged.

Flags:
  --n <count>    how many recent commits to scan (default 30)
`,
  'audit-history': `pebbl audit-history — one-time read-only scan of committed .md history

Walks ALL committed .md blobs across \`git log --all\` (not just the working
tree) and flags three leak classes that append-only memory could never
un-leak once shared: non-RFC1918 IPs and host:port pairs, credential file
paths (.env / .claude-env / /etc/*-bot.env), token shapes, and PII names from
the repo's anon name-map. Emits a per-finding rotation checklist (file,
commit, line, class, ROTATE/ACCEPT prompt).

READ-ONLY by default: the scan never edits, redacts, force-pushes, or stages
anything. A real leaked secret must be ROTATED at its source — this tool only
surfaces it. Run it before taking any store \`--shared\`, and pair it with the
pre-commit / pre-push gate that scans every new commit/push going forward.

Recording decisions (the only writes this command makes, and only to the
ledger file — never to git history):
  --accept <id> --reason "..."   record an ACCEPT so the pre-push gate stops
                                 re-asking about this finding
  --accept all --reason "..."    accept every finding currently listed
  --revoke <id>                  un-accept; it blocks pushes again
  --list-accepted                show every recorded decision

Why accepts are needed: a finding inside a commit that is ALREADY on the public
remote can never be scrubbed without rewriting published history, which
append-only memory refuses to do. Without a ledger the pre-push gate would block
forever and the only way out would be PEBBL_SKIP_SCAN — which trains you to
always skip it, disarming the gate for the day a REAL leak appears. An accept is
scoped to one leaked string in one file (not one commit), requires a written
reason, and never hides a NEW finding. The ledger is committed so a clone
inherits the decisions; a corrupt one fails CLOSED and accepts nothing.

For a doc that must QUOTE a leak example (this scanner's own spec did), put
\`allowlist-secret\` on that line — a line-scoped, greppable exemption.
`,
  init: `pebbl init — set up .pebbl/ in current project

Creates .pebbl/ with sqlite store, writes PEBBL.md at project root,
and adds a pebbl block (sentinel-marked) to AGENTS.md if present.
`,

  log: `pebbl log "[message]" — record a decision or note

Flags:
  --cat <category>     ${'decision|structure|pattern|data|integration|quality|steering'}
  --topic <topic>      free-form topic (e.g. "auth,api")
  --tier <tier>        foundation|component|detail|fleeting
  --scope foundation   shortcut: promote to foundation tier
  --source <source>    human|agent|hook (default: human)
  --relates <id>       link to a related entry ID
  --corrects <id>      supersede a prior entry (old entry stays searchable, marked corrected)
  --key <identity>     this is the SAME FACT as before. A repeat assert of a key
                       that already has a live entry COUNTS instead of adding a
                       row (and does not grow manual-logs.md), so a job that
                       re-reports the same finding on every pass leaves one entry
                       with occurrences=N rather than N copies. Identity is
                       scoped to the live belief: once an entry is superseded its
                       key is free again. Ignored alongside --corrects, because
                       "the belief changed" is not "the same fact again".
  --outcome <outcome>  failed|worked — did the thing described actually work?
                       'failed' is the one readback leads with ("ALREADY TRIED —
                       did NOT work"), so a later agent stops re-running a dead
                       end instead of rediscovering it.
  --share              publish a foundation entry to the SHARED (committed) log
                       even on a public remote. Foundation entries are
                       PRIVATE-BY-DEFAULT on a PUBLIC remote (they land in the
                       gitignored events.local.jsonl); --share opts one into
                       the committed events.jsonl. On a private remote
                       foundation shares freely and --share is a no-op.

${CATEGORIES}

${TIERS}

Examples:
  pebbl log "threshold is 0.5 because Professional Services touches everything at 0.2" --cat decision
  pebbl log "uses SQLite for the log store" --cat structure --tier foundation
  pebbl log "recurring mess [sig-4c93ec]" --key sig-4c93ec        # 2nd+ call counts, no duplicate
  pebbl log "raising the guard threshold to 3 did not cut false positives" --outcome failed

Tip: if you omit --cat, the rubric tries to classify. If it falls
back to 'uncategorized', pebbl prints a loud warning.

Secret guard: an unmarked secret-shape (token class) is BLOCKED before it can
enter the store (nothing is written, exit 1). Add \`allowlist-secret\` to the
line for a deliberate fixture, or set PEBBL_SECRET_GUARD=warn|off to relax it.
`,

  search: `pebbl search "[query]" — semantic + keyword search

Flags:
  --cat <category>     filter by category
  --topic <topic>      filter by topic
  --include-archive    also show compacted/archived history (ranked last)

${CATEGORIES}
`,

  readback: `pebbl readback <spec-file | -> — surface colliding prior work for an incoming task

Deterministic, NO-LLM. Reads an incoming task spec (a file path, or '-' for
stdin) and surfaces prior memory entries that COLLIDE with it — i.e. share a
real artifact, file path, or code identifier — so you RESUME or SUPERSEDE the
prior work instead of rebuilding it. A shared TOPIC word (factory, review,
promote) never trips a collision; only an identifier/artifact/path does. Run it
before a task is claimed/started, before any code is written.

readback only makes the collision AVAILABLE; whether you obey it is your call
(the structural "agent must obey" half is a separate, planned piece).

Matching routes through the same FTS5 path as 'pebbl search' (porter stemming +
synonym expansion + bm25), so a paraphrase or rename still has a chance to hit.
Collision-bearing results sort above related-only ones; importance/usage order
them within the collision set. Read-only — never writes to the store.

Flags:
  --json               emit the result array as JSON:
                       [{eid, matched_on, score, collision, verdict_hint}]
  --top <N>            keep only the top N results
  --factory-guide      print the static factory-integration manifest
                       (trigger-conditions + BUILT|PLANNED edges); --json for JSON

Examples:
  pebbl readback ./prompts/active/some-task.md
  cat task-spec.md | pebbl readback -
  pebbl readback --factory-guide --json
`,

  liveness: `pebbl liveness — detect the ABSENCE of an expected event (silent-fail detection)

Deterministic, NO-LLM. The factory's worst failures are SILENT: a scheduled job
that just doesn't run leaves no error to catch. You can't watch for an absence,
so flip it to "when did this last succeed?" — declare a cadence, beat a heartbeat
on verified success, and 'check' flags what is OVERDUE.

  pebbl liveness register <name> --every <dur> [--grace <dur>]
       declare a cadence contract for a job. <dur> is a duration: 24h, 90m, 2d,
       45s, 1w (a bare number is seconds). A registered job that never beats is
       OVERDUE from the moment it was registered.

  pebbl liveness check [--json]
       walk the registry and flag OVERDUE jobs (now - last_beat > every + grace).

SELF-PROVING: 'check' beats its OWN liveness-check heartbeat and asserts its
freshness first, and the registry carries a PLANTED always-overdue sentinel that
every healthy check MUST report as OVERDUE. A check that reports ZERO overdue is
itself broken (blind, not green) — it exits NON-ZERO and prints LOUD. 'check'
prints the registry count it walked + the sentinel's status.

A heartbeat is a LIVENESS signal, not a CORRECTNESS signal — it asserts a run
reached the end beat; whether the output was right is a separate freshness check.

Flags:
  --json               machine-readable output (register/check)
  --factory-guide      print the static factory-integration manifest
                       (trigger-conditions + BUILT|PLANNED edges); --json for JSON

Examples:
  pebbl liveness register triage --every 24h --grace 1h
  pebbl liveness check --json
  pebbl liveness check --factory-guide --json
`,

  heartbeat: `pebbl heartbeat <name> [--proof <token>] — beat a liveness signal for a job

Deterministic, NO-LLM. Records that <name> is alive at now. Beat on SUCCESS,
LAST, AFTER the artifact is written and verified — a heartbeat is a LIVENESS
signal, not a CORRECTNESS signal (it asserts the run reached the end beat; the
work being right is a separate artifact/freshness check). The absence of a beat
is what 'pebbl liveness check' later alarms on.

Flags:
  --proof <token>      an evidence token (row count / output hash / artifact
                       path) so a "beat but produced nothing" run is inspectable
  --json               machine-readable output
  --factory-guide      print the static factory-integration manifest
                       (trigger-conditions + BUILT|PLANNED edges); --json for JSON

Examples:
  pebbl heartbeat triage --proof "wrote state/triage-heartbeat.txt"
  pebbl heartbeat morning-brief
  pebbl heartbeat --factory-guide --json
`,

  recurrence: `pebbl recurrence <signature> — the band-aid detector (frequency vs resistance)

Deterministic, NO-LLM. Turns repeated friction into an escalation signal, and
separates FREQUENCY (a symptom recurs a lot -> encode it) from RESISTANCE (it
recurred AFTER a fix that actually touched ROOT -> the fix didn't take ->
escalate higher).

ALTITUDE IS OBSERVED, NOT SELF-REPORTED. The closing agent does NOT grade its
own fix. Its 'fix_altitude_claimed' is only a CLAIM; pebbl OBSERVES the real
altitude from the lesson's 'changed_files' via a blast-radius heuristic — a fix
that touches a shared/definer file (lib/config/bootstrap/schema/single-definer)
OR lands a test/regression-guard is 'root'; a single leaf file with no test is
'patch'. RESISTANCE is computed from the OBSERVED altitude, never the claim. A
claimed-vs-observed DISAGREEMENT ("claimed root, touched only the leaf") is
itself a flag.

The signature is anchored on the fix SITE (the named artifact + changed_files),
not the error string (which the act of fixing mutates), so a re-worded
recurrence still groups. CAVEAT: a LOW resistance count is NOT proof of no
resistance — a fix that renames/relocates/rewords can reset a string signature;
'--scan' surfaces drift candidates.

  pebbl recurrence <signature> [--json]
       {frequency, resistance, last_seen, attempts[{altitude_observed,
       altitude_claimed}], flag}. flag is one of:
         none        novel / below threshold and not resistant
         PATTERN     frequency >= threshold (default 3) — happens a lot
         RESISTANT   >= 1 recurrence after an OBSERVED-root fix (the fix didn't take)
         STRUCTURAL  >= 2 such recurrences (stop fixing it as a bug)

  pebbl recurrence --scan [--json]
       every over-threshold / resistant signature + its flag (the maintenance feed).

encode COMPUTES the flag; the PATTERN->inbox / RESISTANT->Ashley routing is
PLANNED (factory wiring), not this command's job. Read-only — never writes.

Flags:
  --json               machine-readable output
  --threshold <n>      override the PATTERN frequency threshold (default 3)
  --factory-guide      print the static factory-integration manifest
                       (trigger-conditions + BUILT|PLANNED edges); --json for JSON

Examples:
  pebbl recurrence glm-judge-bills-zero --json
  pebbl recurrence --scan --json
  pebbl recurrence --factory-guide --json
`,

  context: `pebbl context — recent entries with rationale warnings & git context

Flags:
  --cat <category>     filter by category
  --topic <topic>      filter by topic
`,

  handoff: `pebbl handoff "[summary]" — create a session handoff for the next agent

Flags:
  --done <items>       semicolon-separated completed items
  --todo <items>       semicolon-separated remaining items
  --blocked <items>    semicolon-separated blockers
  --docs <paths>       comma-separated paths to rendered handoff doc(s) — the
                       readable detail the next agent opens; resurfaced on
                       --latest and \`pebbl context\`
  --no-doc             opt out of the detail-doc requirement for one heavy handoff
  --topic <topic>      free-form topic
  --source <source>    human|agent (default: agent)
  --latest             show the most recent handoff
  --list               list recent handoffs
  --open               list every open handoff (alias: --list-open)
  --list-open          list every open handoff
  --close [id]         close an open handoff (a specific id if given);
                       session detail entries become compaction-eligible;
                       done/todo/blocked stay searchable in handoffs.md

Handoffs materialize one block per --done/--todo/--blocked item into
handoffs.md so each item is independently searchable.

A DETAIL-HEAVY handoff (a lot of done/todo/blocked text) must link a rendered
doc with --docs — a readable document beats detail crammed into the fields, and
a linked doc can't be orphaned. Pass --no-doc to record a terse handoff anyway.
`,

  narrative: `pebbl narrative — view or set the project narrative

  pebbl narrative              show current narrative
  pebbl narrative "..."        set narrative description

Flags:
  --show               show current narrative
  --generate           guide on writing a narrative from foundation entries
`,

  compact: `pebbl compact — compact entries on a topic

Flags:
  --preview                show groups ready for compaction
  --execute                execute compaction
  --resolve <id:action,...>  resolve ambiguous entries

${TIERS}

fleeting entries are pruned; foundation entries are always kept.
`,

  rebuild: `pebbl rebuild — force a rebuild of the view from events.jsonl

Re-folds the canonical .pebbl/events.jsonl into the disposable view
(view.sqlite + the markdown projections). The FTS5 search index is rebuilt
lazily from the view on the next read. The view is normally kept current automatically on every
command, so you rarely need this — reach for it after hand-editing or
repairing events.jsonl, or to force a refresh in a script. Runs under the
per-store lock so it can't interleave with a concurrent write.
`,

  feedback: `pebbl feedback "[message]" — drop feedback when pebbl misbehaves here

Flags:
  --list               review feedback recorded in this repo
`,

  upgrade: `pebbl upgrade — update .pebbl/ to the latest version

Auto-migrates the AGENTS.md pebbl block to the current sentinel format
and overwrites PEBBL.md at project root.
`,

  eject: `pebbl eject — remove pebbl config from this project

Strips the pebbl sentinel block from AGENTS.md and removes PEBBL.md.
Leaves .pebbl/ in place (delete it yourself if you want a clean slate).
`,

  'log-commit': `pebbl log-commit — called by git post-commit hook
Not meant for direct invocation.
`,

  'privacy-scan': `pebbl privacy-scan — called by the pre-commit / pre-push git hooks

Scans staged (\`--staged\`) or to-be-pushed (\`--push\`) content for the three
leak classes (non-RFC1918 IP+port, credential file paths, denylisted PII
names) plus token shapes, and exits non-zero on a hit to refuse the
commit/push. On \`--push\` to a PUBLIC remote it also enforces the hard gate:
a clean full-history .md scan must pass. Not meant for direct invocation;
\`PEBBL_SKIP_SCAN=1\` bypasses it. See also: pebbl audit-history.
`,

  'migrate-to-events': `pebbl migrate-to-events — lift db.sqlite into events.jsonl

Reads the binary store once in (timestamp, id) order, mints time-seeded
ULIDs, builds the oldInt->ULID map BEFORE remapping any reference, and
remaps every foreign-key site (logs.relates_to, logs.corrects,
handoffs.promoted_log_id, and per-element session_entries / session_commits)
into append-only events — aborting the whole store if any reference dangles.

DRY-RUN by default: prints the audit + plan and writes nothing. Idempotent:
a second run on an already-migrated store is a safe no-op.

Flags:
  --apply        actually migrate: write events.jsonl and rename
  --write        db.sqlite -> legacy-db.sqlite (rollback artifact)

Without a flag, nothing on disk changes. db.sqlite is NEVER deleted.
`,

  'repair-rollups': `pebbl repair-rollups — repair a compaction whose rollup membership is wrong

Detects supersede (rollup) events whose recorded rolls_up members do not
match the entries the rollup's own concatenated text was built from (the
id-drift mis-roll: a positional int->eid map shifted by phantom db-only
rows). Then repairs APPEND-ONLY — history is never rewritten:

  - a wrongly-suppressed entry (hidden, content in NO live rollup text) is
    restored by a fresh append event carrying the original fields plus a
    restores:<eid> audit field
  - an escaped duplicate (live, but its content already sits in a newer
    live rollup's text) is hidden by an expire event

DRY-RUN by default: prints the diagnosis + plan and writes nothing.
Idempotent: a second run plans nothing.

Flags:
  --apply        append the repair events and rebuild the read model
`,
};

const TOPLEVEL = `pebbl — local project memory

Usage:
  pebbl <command> [args]
  pebbl <command> --help        details for one command
  pebbl help <topic>            topic guide (${Object.keys(TOPICS).join(', ')})

Commands:
  init        set up .pebbl/ in current project
  log         record a decision or note
  search      semantic + keyword search
  readback    surface colliding prior work for an incoming task spec
  liveness    detect silent fails: register a cadence, check what is OVERDUE
  heartbeat   beat a liveness signal for a job (on verified success)
  recurrence  the band-aid detector: frequency vs resistance, altitude observed
  context     recent entries with git context
  handoff     create a session handoff
  narrative   view or set project narrative
  compact     compact entries
  doctor      report-only memory-health check (contradictions, staleness, missing files)
  audit-history  read-only scan of committed .md history for leaks
  feedback    record feedback about pebbl
  upgrade     update .pebbl/ to latest
  eject       remove pebbl config
  log-commit  (git hook only)
`;

function printToplevel() {
  console.log(TOPLEVEL);
}

function printSubcommand(name) {
  const text = SUBCOMMANDS[name];
  if (!text) {
    console.error(`pebbl: no help for '${name}'`);
    process.exit(1);
  }
  console.log(text);
}

function printTopic(name) {
  const text = TOPICS[name];
  if (!text) {
    console.error(`pebbl help: unknown topic '${name}'`);
    console.error(`  topics: ${Object.keys(TOPICS).join(', ')}`);
    process.exit(1);
  }
  console.log(text);
}

module.exports = { printToplevel, printSubcommand, printTopic, SUBCOMMANDS, TOPICS };
