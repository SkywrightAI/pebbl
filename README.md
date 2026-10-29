# pebbl — Local Project Memory

**A CLI tool that lets AI agents (and humans) remember project decisions, conventions, and patterns without re-discovering them.**

Think of it as a searchable, lightweight second brain for your codebase — one that survives across agent sessions and keeps your architectural intent from getting lost.

## What pebbl solves

When an AI agent works on your code, it needs context: *Why did we choose this storage format? Which libraries are required? What patterns do we follow? What constraints exist?* Without it, agents either:
- Burn tokens re-discovering decisions you already made
- Contradict earlier choices, creating inconsistency
- Miss conventions and constraints, leading to rework

Pebbl keeps this context in a **local SQLite database**, queryable by both humans and agents. When the next agent (or you, 6 months from now) picks up the work, that context is there.

## Core concepts

### Entry categories

Every note in pebbl falls into one of 7 categories:

| Category | Examples |
|----------|----------|
| **decision** | Chose PostgreSQL over MongoDB; use UUIDs not auto-increment IDs |
| **structure** | Notes module owns indexing; auth and payments are separate services |
| **pattern** | All dates in ISO 8601; errors always include a trace ID |
| **data** | Schema: users table has (id, email, created_at, tags); search returns top 5 matches |
| **integration** | OAuth provider: Google, sign-in flow uses PKCE, tokens cached in localStorage |
| **quality** | Search latency target: < 200ms; test coverage: > 80% |
| **steering** | Branch parked after failing review 3x; hotfix for the regression in search ranking; recurring friction worth encoding |

`steering` records a course-correction or friction: what went wrong, what was
learned, what to do differently. The `--corrects <id>` flag additionally links
the entry that supersedes a prior one. Use either or both. (`correction` is a
deprecated alias for `steering`, still accepted on `--cat`.)

### Entry tiers

Entries have a lifecycle. You decide how long they stay:

| Tier | Purpose | Keeps | Compacts? |
|------|---------|-------|-----------|
| **foundation** | Project-wide architecture decisions | Forever — never compacts |
| **component** | Module-level decisions, conventions | Compacts when 15+ on same topic |
| **detail** | Implementation notes, gotchas, research | Compacts when 10+ on same topic |
| **fleeting** | Session summaries, temporary notes | 30 days, auto-deleted |

### Search

Pebbl uses SQLite FTS5 full-text search ranked by BM25 over your memory, with synonym expansion so related terms still match. No external tool or model — the only native dependency is `better-sqlite3`:
```bash
pebbl search "how do we store user data?"  # returns schema entries, storage decisions
pebbl search "caching strategy"            # returns cache pattern, performance targets
```

## Quick start

### 0. Install dependencies (pnpm)

This repo pins pnpm via corepack and ships a supply-chain cooldown:

```bash
corepack enable && corepack prepare pnpm@11.5.3 --activate
pnpm install
pnpm approve-builds better-sqlite3   # one-time: compiles the sqlite binding
```

`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`, so pnpm refuses any
dependency version published less than 24h ago - poisoned releases are
almost always detected and pulled within hours. Build scripts are denied
by default; the same file allowlists only `better-sqlite3` (native binding).

### 1. Install the CLI

You need `pebbl` on your PATH. Two options:

**Option A — npm link** (ties the command to this checkout):

```bash
npm link
```

This creates a global symlink so `pebbl` resolves to `./bin/pebbl.js` in
whichever Node prefix is active.

**Option B — manual symlink** (zero-dependency, works with any shell):

```bash
ln -s "$PWD/bin/pebbl.js" ~/bin/pebbl
```

`~/bin` must be on your PATH. Add this to `~/.zshrc` or `~/.bashrc` if it
isn't already:

```bash
export PATH="$HOME/bin:$PATH"
```

Then reload your shell (`source ~/.zshrc`) and confirm:

```bash
pebbl help
```

### 2. Initialize pebbl in your project

```bash
pebbl init
```

This creates `.pebbl/` with:
- `db.sqlite` — your project memory (searchable, queryable)
- `rubric.yml` — rules for auto-classifying entries
- `config.yml` — pebbl settings (`handoff:` picks when a handoff must link a doc; `session_check:` opts into the decisions-file check)
- `AGENTS.md` — guidance for agents to follow, rendered from `config.yml`

It also installs, outside `.pebbl/`:
- five git hooks (commit capture, rebuild sentinel, privacy scan), pinned to this pebbl and node
- `@AGENTS.md` at the top of an existing `CLAUDE.md`, so Claude Code reads the guidance
- a Claude Code Stop hook in `.claude/settings.local.json` (`pebbl check-session`) that holds a turn which changed files without logging; skip it with `--no-claude-hooks`
- a narrative seeded from README's first paragraph, if none is set

Hooks don't travel with git: after cloning a repo that uses pebbl, run `pebbl upgrade` to put them back.

Commit `.pebbl/` (but not the markdown projections — they're cached).

### 3. Log decisions as you work

```bash
# During development, capture architectural choices:
pebbl log "chose SQLite for metadata" --cat decision --topic storage

# Log conventions:
pebbl log "all dates are ISO 8601 in the schema" --cat pattern --topic conventions

# Link related entries:
pebbl log "notes depend on search for full-text indexing" --cat structure --topic notes --relates 42

# Mark when a decision changes:
pebbl log "switched to PostgreSQL for better querying" --cat decision --topic storage --corrects 7
```

### 4. Give agents context before they start

When handing off work to an agent, give them the relevant context:

```bash
# Get recent decisions on auth:
pebbl context --topic auth

# Get all decisions (not implementation details):
pebbl context --cat decision

# Paste output into your agent prompt — it will have the decisions without re-discovering them.
```

### 5. Search when you need specific info

```bash
# Semantic search — find related ideas:
pebbl search "metadata storage"

# Or filter by category:
pebbl search "caching" --cat pattern
```

### 6. Compact when detail entries pile up

As you work, detail entries (implementation notes, gotchas, research) accumulate. When there are 10+ on the same topic, pebbl suggests compaction:

```bash
# See what's ready to compact:
pebbl compact --preview

# Compact (rolls up detail into summaries, archives originals):
pebbl compact --execute
```

Foundation entries (project-wide decisions) never compact — they're permanent. Component entries compact when 15+ share the same topic.

## Getting started: for humans

Install globally:

```bash
npm install -g pebbl
```

Then in any git repo:

```bash
pebbl init                  # Set up .pebbl/
pebbl log "your note"       # Start logging
pebbl context               # Dump recent context for copy/paste
```

Flag cheat sheet:
- `--cat <decision|structure|pattern|data|integration|quality|steering>` — what kind of entry (`correction` is a deprecated alias for `steering`)
- `--topic <name>` — one or more topics (comma-separated: `--topic auth,api`)
- `--tier <foundation|component|detail|fleeting>` — how long to keep it (default: detail)
- `--scope foundation` — mark as project-level decision (auto-sets tier to foundation)
- `--source <human|agent|hook>` — who logged it (default: human)
- `--relates <id>` — link to another entry
- `--corrects <id>` — mark that this corrects a prior entry

Handoff flags:
- `--done <items>` — semicolon-separated completed items
- `--todo <items>` — semicolon-separated remaining items
- `--blocked <items>` — semicolon-separated blockers
- `--latest` — show the most recent handoff
- `--list` — list recent handoffs
- `--close` — close an open handoff; session detail entries become compaction-eligible; done/todo/blocked stay searchable in handoffs.md

## Getting started: for agents

If you're an AI agent working on a codebase with pebbl initialized:

1. **Before writing code**, read the decisions:
   ```bash
   pebbl context --cat decision
   pebbl search "auth" --cat decision
   ```

2. **As you work**, log decisions (especially ones that weren't made before):
   ```bash
   pebbl log "chose bcrypt for password hashing" --cat decision --topic auth
   ```

3. **At the end of your session**, create a handoff:
   ```bash
   pebbl handoff "built password reset flow" \
     --done "bcrypt hashing; email verification; tests" \
     --todo "rate limiting; forgot-password UI" \
     --topic auth --source agent
   ```

4. **At the start of the next session**, the handoff shows automatically in `pebbl context`. Close it when you've picked up the work:
   ```bash
   pebbl handoff --close
   ```

See `AGENTS.md` in your repo for the full protocol.

## Why pebbl?

### For teams with AI agents
- Handoffs are structured: `pebbl handoff` captures done/todo/blocked with auto-collected session context
- Consistency: agents follow patterns they can query, not guess
- Learning: each agent's session summary becomes context for the next

### For humans maintaining code
- Future you has context: why this library? why this structure?
- Searchable decisions: find "why did we choose X?" without grep
- Compaction keeps memory from bloating: detail entries roll up automatically

### Technical details
- **Local-first**: no cloud, no sync — `.pebbl/` lives in your git repo
- **Fast search**: SQLite FTS5 full-text indexing ranked by BM25
- **Conflict-aware**: supports `--relates` and `--corrects` to track related and contradicting decisions
- **Zero overhead**: pebbl logs are auto-captured from git commits (you only type what matters)

## Common workflows

### "The previous engineer left, what did they decide?"
```bash
pebbl context --cat decision    # Read all decisions in order
pebbl search "deployment"       # Find decisions about how the app ships
```

### "I'm implementing a feature, what's the pattern?"
```bash
pebbl search "caching strategy"     # Find caching decisions
pebbl search "API error handling"   # Find error patterns
pebbl context --cat pattern         # See all conventions
```

### "I'm taking over this project from an agent"
```bash
pebbl context                   # Paste this into your prompt
# Now you have all recent decisions without re-discovering them
```

### "This entry is out of date"
```bash
pebbl log "we now use async/await, not Promises" --cat pattern --topic conventions --corrects 12
# Entry 12 is superseded by this new one in the UI
```

### "I'm handing off to another agent"
```bash
pebbl handoff "implemented search, chose lunr.js" \
  --done "full-text index; query API; tests" \
  --todo "pagination; fuzzy matching" \
  --topic search --source agent
```

### "I'm picking up from a previous agent"
```bash
pebbl context                   # shows open handoff at top
# ... do the work ...
pebbl handoff --close           # session detail entries become compaction-eligible; done/todo/blocked stay searchable
```

## File structure

```
.pebbl/
├── db.sqlite          # The source of truth (queries here)
├── rubric.yml         # Auto-classification rules
├── config.yml         # Pebbl settings (compaction threshold, etc.)
├── manual-logs.md     # Markdown projection (cached, human-readable)
├── commit-log.md      # Auto-captured git commits (cached, human-readable)
└── archive/           # Compacted entries (for reference)
```

The SQLite database is the authority. Search runs over an FTS5 index built from it; the markdown files are human-readable projections and can be regenerated anytime.

## Configuration

Edit `.pebbl/config.yml` to customize:
- `detail_threshold: 10` — how many detail entries on one topic before suggesting compaction
- `fleeting_days: 30` — how long to keep fleeting entries
- Search backend, compaction behavior, etc.

## Contributing

Pebbl is designed to be extended. The core is:
- Structured entry model (SQLite schema in `src/db.js`)
- CLI (`bin/pebbl.js` routes to handlers in `src/`)
- Tests (`test/` with Node's built-in runner)

No external dependencies beyond `better-sqlite3`. Contributions welcome.

## License

MIT
