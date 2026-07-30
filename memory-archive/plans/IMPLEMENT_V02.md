# Pebbl v0.2 — Implementing Agent Briefing

You are implementing pebbl v0.2. This document contains everything you need.
Work one phase at a time. Verify each phase before starting the next.
The source repo is at `/Users/ashley/Documents/pebbl`.

**Quick-reference companion:** The plan file at `.claude/plans/logical-sprouting-moon.md`
has summary tables you'll want open alongside this doc: tag taxonomy, three-tier model,
phase sequencing diagram, line budget per file, and the end-to-end verification checklist.

---

## Design decisions (why, not what)

These decisions were made during a full design session. Don't revisit them unless
you hit a concrete problem that forces it. If you do change something, log why.

**Why 6 categories, not 9 or 2:**
Research pulled from ADR, arc42, ISO 42010 frameworks suggested 9 tags. We collapsed
`constraint` and `risk` into `decision` (constraints are decisions you didn't make,
tech debt is a deferred decision) and dropped `infra` (coding agents rarely need
deploy topology). 6 tags means no ambiguous overlaps — every entry has an obvious home.

**Why frequency-triggered compaction, not time-based:**
Architecture decisions are low-volume and individually important — they'd never hit a
time-based compaction window. Bug fixes are high-volume and individually forgettable.
Frequency-based means compaction adapts to how you actually work. A quiet month
produces no compaction. A sprint with 20 fixes triggers rollup naturally.

**Why hard regex rules, not AI classification:**
The working agent (Opus-class) can't spawn a cheaper model for classification. Ollama
was considered but adds a dependency. Regex patterns cover 80%+ of cases deterministically
and work offline. The 20% ambiguous cases surface during compaction review where a real
agent handles them.

**Why dual-write (SQLite + markdown) instead of SQLite-only:**
SQLite is authoritative. Markdown exists because QMD needs markdown files to index, and
because a human-readable file survives SQLite corruption. This is a materialized view,
not duplicated logic. The PP DRY principle applies to logic and decisions, not to caches.

**Why `relates_to` and `corrects` fields ship now (unused):**
They're two nullable INTEGER columns — ~8 lines of code. Adding them later via migration
is free, but having them in schema now means a future self-learning layer doesn't need a
migration at all. This was evaluated against "don't over-architect" and accepted because
the cost is negligible and the fields are inert (no code reads them in v0.2).

**Why Zettelkasten tiers (fleeting/literature/permanent):**
Fleeting = auto-captured session logs (safe to delete because you never wrote them
deliberately). Detail = manual notes (roll up into summaries, archive originals).
Signal = architecture decisions (permanent, never compact). This maps deletion safety
to intent: if you took the time to type it, a trace always survives.

**Why no session system hook:**
Claude Code Stop hooks can't generate summaries — they run shell commands, not prompts.
The agent itself has the context to write a one-line summary. AGENTS.md guidance telling
agents to log at session end is simpler and more reliable than a system hook.

**Why archive is plain text, not embedded:**
Archived entries are historical — you'd only grep them if something went wrong. Embedding
and indexing them wastes resources. Plain text in `.pebbl/archive/YYYY-MM.txt` is greppable,
human-readable, and costs nothing to maintain.

---

## What pebbl is

A local CLI project memory tool. Agents use it to store and retrieve decisions,
architecture facts, and conventions about a codebase. Currently 386 lines of
Node.js across 9 files. No build step. CommonJS throughout.

---

## Current source (read before writing anything)

### bin/pebbl.js (28 lines)
```js
#!/usr/bin/env node
'use strict';

const [,, command, ...args] = process.argv;

const commands = {
  init:         () => require('../src/init')(),
  log:          () => require('../src/log')(args[0]),
  search:       () => require('../src/search')(args.join(' ')),
  context:      () => require('../src/context')(),
  eject:        () => require('../src/eject')(),
  'log-commit': () => require('../src/log-commit')(args[0], args[1], args[2]),
};

if (!command || !(command in commands)) {
  console.log(`pebbl — local project memory\n\nUsage:\n  pebbl init\n  pebbl log "[message]"\n  pebbl search "[query]"\n  pebbl context\n  pebbl eject\n  pebbl log-commit\n`);
  process.exit(command ? 1 : 0);
}

commands[command]();
```

### src/db.js (27 lines)
```js
'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  source    TEXT NOT NULL DEFAULT 'manual',
  message   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  hash      TEXT NOT NULL,
  message   TEXT NOT NULL,
  files     TEXT
);
`;

function openDb(pebblDir) {
  const db = new Database(path.join(pebblDir, 'db.sqlite'));
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
```

### src/log.js (26 lines)
```js
'use strict';
const fs = require('fs');
const path = require('path');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { qmdUpdate } = require('./qmd');

module.exports = function log(message) {
  if (!message || !message.trim()) {
    console.error('Usage: pebbl log "[message]"');
    process.exit(1);
  }

  const pebblDir = requirePebblDir();
  const ts = new Date().toISOString();
  const entry = `## ${ts} - ${message.trim()}\n\n`;

  fs.appendFileSync(path.join(pebblDir, 'manual-logs.md'), entry);

  const db = openDb(pebblDir);
  db.prepare('INSERT INTO logs (timestamp, source, message) VALUES (?, ?, ?)').run(ts, 'manual', message.trim());

  qmdUpdate(pebblDir);

  console.log(`[${ts.slice(0, 10)}] ${message.trim()}`);
};
```

### src/search.js (22 lines)
```js
'use strict';
const { requirePebblDir } = require('./find-pebbl');
const { qmdQuery } = require('./qmd');

module.exports = function search(query) {
  if (!query || !query.trim()) {
    console.error('Usage: pebbl search "[query]"');
    process.exit(1);
  }

  const pebblDir = requirePebblDir();
  const raw = qmdQuery(pebblDir, query.trim());

  if (!raw.trim()) {
    console.log('No results found.');
    return;
  }

  console.log(`\n--- SEARCH: ${query} ---`);
  console.log(raw.trim());
  console.log('---\n');
};
```

### src/context.js (34 lines)
```js
'use strict';
const fs = require('fs');
const path = require('path');
const { requirePebblDir } = require('./find-pebbl');

module.exports = function context() {
  const pebblDir = requirePebblDir();
  const logFile = path.join(pebblDir, 'manual-logs.md');

  if (!fs.existsSync(logFile)) {
    console.log('--- PROJECT MEMORY ---\n(no entries yet)\n---');
    return;
  }

  const lines = fs.readFileSync(logFile, 'utf8').split('\n');
  const entries = [];

  for (const line of lines) {
    const match = line.match(/^## (\S+) - (.+)$/);
    if (match) {
      const date = match[1].slice(0, 10);
      entries.push(`[${date}] ${match[2]}`);
    }
  }

  const last5 = entries.slice(-5);
  console.log('--- PROJECT MEMORY ---');
  if (last5.length === 0) {
    console.log('(no entries yet)');
  } else {
    last5.forEach(e => console.log(e));
  }
  console.log('---');
};
```

### src/qmd.js (current — already updated)
```js
'use strict';
const { execSync, spawnSync } = require('child_process');

function qmdAvailable() {
  const result = spawnSync('which', ['qmd'], { encoding: 'utf8' });
  return result.status === 0;
}

function qmdCollectionCreate(pebblDir) {
  execSync(`qmd collection add "${pebblDir}" --name pebbl`, { stdio: 'inherit' });
}

function qmdUpdate(pebblDir) {
  if (!qmdAvailable()) return;
  spawnSync('qmd', ['update', pebblDir], { stdio: 'ignore' });
}

function qmdQuery(pebblDir, query) {
  if (!qmdAvailable()) {
    console.error('qmd not found. Install it: npm install -g @tobilu/qmd');
    process.exit(1);
  }
  const result = spawnSync('qmd', ['search', query, '-c', 'pebbl'], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result.stdout || '';
}

module.exports = { qmdAvailable, qmdCollectionCreate, qmdUpdate, qmdQuery };
```

### src/find-pebbl.js (28 lines)
```js
'use strict';
const fs = require('fs');
const path = require('path');

function findPebblDir() {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.pebbl');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function requirePebblDir() {
  const dir = findPebblDir();
  if (!dir) {
    console.error('No .pebbl/ directory found. Run `pebbl init` first.');
    process.exit(1);
  }
  return dir;
}

module.exports = { findPebblDir, requirePebblDir };
```

### src/log-commit.js (28 lines)
```js
'use strict';
const fs = require('fs');
const path = require('path');
const { findPebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { qmdUpdate } = require('./qmd');

module.exports = function logCommit(hash, message, files) {
  try {
    const pebblDir = findPebblDir();
    if (!pebblDir) return;

    const ts = new Date().toISOString();
    const shortHash = (hash || 'unknown').slice(0, 8);
    const msg = (message || '').trim().split('\n')[0];
    const fileList = (files || '').replace(/,$/, '');

    const entry = `## ${ts} - ${shortHash}: ${msg}\n\nFiles: ${fileList || '(none)'}\n\n`;
    fs.appendFileSync(path.join(pebblDir, 'commit-log.md'), entry);

    const db = openDb(pebblDir);
    db.prepare('INSERT INTO commits (timestamp, hash, message, files) VALUES (?, ?, ?, ?)').run(ts, hash, msg, fileList);

    qmdUpdate(pebblDir);
  } catch {
    // Never block a commit
  }
};
```

---

## Dependencies

- `better-sqlite3` — already installed, the only dependency
- Node >= 18 built-ins only (fs, path, child_process)
- No new npm packages. No TypeScript. No build step.
- Tests use `node:test` (built-in, zero deps)

---

## Data authority rule

**SQLite is the single source of truth.**
Markdown files are projections — generated from SQLite, read by QMD for indexing.
Write path: INSERT into SQLite first, then append to markdown (same function call).
If they ever conflict, SQLite wins. Compaction regenerates markdown from SQLite.

---

## QMD integration note

QMD is an external CLI tool (`qmd`) for hybrid BM25+vector search over markdown.
Install: `npm install -g @tobilu/qmd`
Pebbl calls it via `spawnSync`. It is optional — if not installed, log still works.

**Correct commands (already reflected in src/qmd.js):**
- Collection init: `qmd collection add "<dir>" --name pebbl`
- Search: `qmd search "<query>" -c pebbl`
- Update index: `qmd update <dir>`

**Real QMD output format** (confirmed from live run):
```
qmd://pebbl/commit-log.md:3 #213e76
Title: Commit Log
Score:   0%

@@ -2,4 @@ (1 before, 6 after)

## 2026-05-23T12:55:56.851Z - 88cf30ce: docs(clipforge): document eval framework

Files: 02-modules/clipforge.md


qmd://pebbl/manual-logs.md:9 #e40b17
Title: Manual Logs
Score:   0%

@@ -8,4 @@ (7 before, 24 after)

## 2026-05-23T12:20:57.600Z - FFmpeg chosen for clipforge edit pipeline
```

Each result block starts with `qmd://pebbl/<filename>:<line> #<hash>`, followed by
Title, Score, a diff-style context block, then the markdown chunk content.

**Parsing strategy for Phase 4 search post-filtering:**
Split stdout on `\nqmd://` to get individual result blocks. For each block:
1. Extract the markdown content after the `@@` line
2. Look for the `<!-- cat:... topic:... tier:... source:... -->` comment in the content
3. Apply `--cat` / `--topic` filters based on parsed comment
4. If no comment found (pre-v0.2 entry): include result unfiltered (defensive default)

Display each matching result with file/line reference stripped — show only the
message text and metadata badge.

---

## Implementation plan (phase by phase)

### Phase 1 — Args parser + schema migration

**New file: `src/args.js`**

Minimal `--flag value` parser. No dependencies.
- Known flags: `cat`, `topic`, `source`, `tier`, `relates`, `corrects`, `preview`, `execute`
- Boolean flags (no value following): `preview`, `execute`
- Returns `{ flags, positional }` where positional is the remaining args joined

```js
// Example behaviour
parseArgs(['chose SQLite', '--cat', 'decision', '--topic', 'datastore'])
// → { flags: { cat: 'decision', topic: 'datastore' }, positional: ['chose SQLite'] }

parseArgs(['--preview'])
// → { flags: { preview: true }, positional: [] }
```

**Modify: `src/db.js`**

New schema (replace existing SCHEMA constant):
```sql
CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'human',
  category   TEXT    NOT NULL DEFAULT 'uncategorized',
  tier       TEXT    NOT NULL DEFAULT 'detail',
  message    TEXT    NOT NULL,
  topics     TEXT,
  relates_to INTEGER,
  corrects   INTEGER
);
CREATE TABLE IF NOT EXISTS commits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  hash      TEXT NOT NULL,
  message   TEXT NOT NULL,
  files     TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
CREATE INDEX IF NOT EXISTS idx_logs_tier ON logs(tier);
```

Call `migrate(db)` from `openDb()` after `db.exec(SCHEMA)`.

**New file: `src/migrate.js`**

```js
// Check PRAGMA table_info(logs) for 'category' column
// If missing, run:
//   ALTER TABLE logs ADD COLUMN category TEXT NOT NULL DEFAULT 'uncategorized'
//   ALTER TABLE logs ADD COLUMN tier TEXT NOT NULL DEFAULT 'detail'
//   ALTER TABLE logs ADD COLUMN topics TEXT
//   ALTER TABLE logs ADD COLUMN relates_to INTEGER
//   ALTER TABLE logs ADD COLUMN corrects INTEGER
//   UPDATE logs SET source = 'human' WHERE source = 'manual'
// Wrap in a transaction. Log "pebbl: migrated db to v0.2" to stderr.
```

**Verify Phase 1:**
- Copy an existing `.pebbl/db.sqlite` and run any pebbl command — migration runs silently
- `pebbl log "test"` inserts with category=uncategorized, tier=detail, source=human
- `sqlite3 .pebbl/db.sqlite "PRAGMA table_info(logs)"` shows all new columns

---

### Phase 2 — Structured logging

**Modify: `bin/pebbl.js`**
- Change `log` handler: pass full `args` array (not `args[0]`)
- Change `search` handler: pass full `args` array
- Change `context` handler: pass full `args` array
- Add `compact` command: `() => require('../src/compact')(args)`
- Update help text to show new flags and compact command

**Modify: `src/log.js`**

Accept `args` array. Use `parseArgs(args)`.

Validation:
- `--cat` must be one of: `decision`, `structure`, `pattern`, `data`, `integration`, `quality`
  If invalid: print error listing valid values, exit 1
- `--tier` must be one of: `signal`, `detail`, `fleeting`
  If invalid: print error, exit 1
- `--source` must be one of: `human`, `agent`, `hook`. Default: `human`
- `--relates` and `--corrects` are integers. Pass through as-is (no FK validation).
- `--topic` is free-form. Multiple topics: `--topic clipforge,hammy`
- Message is positional remainder joined with spaces

New markdown format (append to manual-logs.md):
```
## 2026-05-23T12:04:15.010Z - chose SQLite over Postgres
<!-- cat:decision topic:datastore tier:signal source:human -->

```

New SQLite insert:
```sql
INSERT INTO logs (timestamp, source, category, tier, message, topics, relates_to, corrects)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```

Output on success:
```
[2026-05-23] [signal|decision] chose SQLite over Postgres
  topics: datastore
```

**Modify: `src/log-commit.js`**

Commits get: `source='hook'`, `tier='fleeting'`, `category='uncategorized'`
Markdown format: add `<!-- cat:uncategorized topic: tier:fleeting source:hook -->` comment line

**Verify Phase 2:**
- `pebbl log "chose X" --cat decision --topic auth --tier signal` → correct entry
- `pebbl log "bare message"` → defaults (uncategorized, detail, human)
- `pebbl log "bad" --cat invalid` → clear error message
- manual-logs.md shows new format with HTML comment

---

### Phase 3 — Rubric system

**New file: `src/rubric.js`**

Load `.pebbl/rubric.yml`. Write a minimal YAML parser (no dependency) that handles
exactly this format:
```yaml
rules:
  - pattern: "regex string"
    category: decision
    tier: signal
```

Parser approach: split on `\n`, detect `  - pattern:`, `    category:`, `    tier:` lines.
Compile each pattern into a case-insensitive RegExp at load time.

Export:
```js
function loadRubric(pebblDir) { ... }  // returns compiled rules array or []
function classifyEntry(rules, message) { ... }  // returns { category, tier } | null
```

If rubric.yml doesn't exist, return empty rules (no-op — entry stays uncategorized).

**Minimal YAML parser spec** (reuse for both rubric.yml and config.yml):
The parser only needs to handle two patterns:
1. A list of objects: `rules:\n  - pattern: "x"\n    category: y\n    tier: z`
2. A flat key-value block: `compaction:\n  threshold: 10\n  fleeting_retention: 30`

Implementation approach:
```js
// Split file by lines. Trim each. Skip comments (# ...) and empty lines.
// Track current context: list item vs block.
// For "  - key: value" → start new list item
// For "    key: value" → add to current list item
// For "key:" with no value → start a named block
// For "  key: value" under a block → add to that block
// Return parsed object.
// Strip quotes from string values. Parse numbers as numbers.
```

**Integrate into `src/log.js`:**

When `--cat` is NOT provided by user:
1. Load rubric
2. Call `classifyEntry(rules, message)`
3. If match: use matched category + tier
4. If no match: keep defaults (uncategorized / detail)

When `--cat` IS provided: skip rubric entirely.
When `--tier` IS provided but `--cat` is not: rubric can set category, explicit tier overrides rubric's tier.

**Modify: `src/init.js`**

After creating db.sqlite, write `.pebbl/rubric.yml` with default content:
```yaml
# Pebbl classification rubric — edit to tune auto-tagging
# Rules are evaluated top-to-bottom; first match wins.
# Pattern is matched case-insensitively against the entry message.

rules:
  - pattern: "chose|decided|decision|picked|went with|trade-?off|constraint"
    category: decision
    tier: signal

  - pattern: "module|component|boundary|owns|ownership|depends on|architecture"
    category: structure
    tier: signal

  - pattern: "convention|pattern|standard|always|never|rule:|style"
    category: pattern
    tier: signal

  - pattern: "schema|model|table|column|migration|data flow|storage"
    category: data
    tier: detail

  - pattern: "api|endpoint|contract|integration|webhook|external"
    category: integration
    tier: detail

  - pattern: "perf|latency|SLA|security|posture|target|benchmark"
    category: quality
    tier: detail

  - pattern: "\\[session\\]"
    category: uncategorized
    tier: fleeting
```

Also write `.pebbl/config.yml`:
```yaml
compaction:
  threshold: 10          # entries per topic before notification appears
  fleeting_retention: 30 # days before fleeting entries are archived/deleted
```

**Verify Phase 3:**
- `pebbl log "chose Postgres over MySQL"` → auto-classifies as decision/signal
- `pebbl log "refactored the auth module boundary"` → structure/signal
- `pebbl log "random note"` → uncategorized/detail
- `pebbl log "chose X" --cat data` → respects explicit flag, ignores rubric

---

### Phase 4 — Enhanced search + context

**Modify: `src/search.js`**

Accept `args` array. Parse `--cat` and `--topic` flags.

After getting QMD raw output, post-filter:
- Split on `\nqmd://` to get individual result blocks
- For each block, extract content after the `@@` context line
- Parse for `/<!-- cat:(\S+) topic:(\S*) tier:(\S+) source:(\S+) -->/`
- If `--cat` provided: drop blocks where parsed category doesn't match
- If `--topic` provided: drop blocks where parsed topics don't include the value
- If no comment found (pre-v0.2 entry): include unfiltered (don't drop)

Display format:
```
--- SEARCH: auth ---
[signal|decision] 2026-05-23 — chose JWT for auth tokens
  topics: auth, security

[detail|structure] 2026-05-22 — auth module boundary with user service
  topics: auth
---
```

If QMD is not available, fall back to a SQLite keyword search using `LIKE '%query%'` on
the message column. This makes search work without QMD installed.

**Modify: `src/context.js`**

Accept `args` array. Parse `--cat` and `--topic`.

Switch from file-reading to SQLite:
```sql
-- base query
SELECT id, timestamp, source, category, tier, message, topics
FROM logs ORDER BY id DESC LIMIT 10

-- with --cat filter
WHERE category = ?

-- with --topic filter  
WHERE ',' || topics || ',' LIKE '%,' || ? || ',%'
  OR topics = ?
  OR topics LIKE ? || ',%'
  OR topics LIKE '%,' || ?
```

Display format:
```
--- PROJECT MEMORY ---
[signal|decision] 2026-05-23 — chose SQLite over Postgres
  topics: datastore
[detail|uncategorized] 2026-05-22 — testing pebbl
---
```

Compaction notification (append after entries if threshold met):
```js
// Query: SELECT topics, COUNT(*) as cnt FROM logs
//        WHERE tier IN ('detail','fleeting')
//        GROUP BY topics HAVING cnt >= threshold
// Load threshold from .pebbl/config.yml (default 10 if file missing)
// If any results: print "[pebbl] N entries on 'topic' ready for compaction. Run: pebbl compact --preview"
```

**Verify Phase 4:**
- `pebbl context` shows last 10 from SQLite with badges
- `pebbl context --cat decision` filters to decisions only
- `pebbl context --topic clipforge` filters to clipforge entries
- `pebbl search "auth" --cat decision` post-filters QMD results (or SQLite fallback)
- Compaction notification appears after 10+ detail entries on one topic

---

### Phase 5 — Compaction

**New file: `src/compact.js`**

Handles both `--preview` and `--execute`. Load config from `.pebbl/config.yml`.

**Core grouping function** (used by both preview and execute):
```js
function buildGroups(db, threshold) {
  // 1. Query: SELECT * FROM logs WHERE tier IN ('detail','fleeting') ORDER BY timestamp
  // 2. For each entry, compute a group key:
  //    - If category === 'uncategorized' → goes to ambiguous list, not a group
  //    - Otherwise: key = `${category}/${primaryTopic}/${month}`
  //      where primaryTopic = (topics || 'general').split(',')[0]
  //      and month = timestamp.slice(0, 7)
  // 3. Collect entries into Map<key, entry[]>
  // 4. Filter: only groups where entries.length >= threshold
  // 5. Return { groups: Map<key, entry[]>, ambiguous: entry[], fleeting: entry[] }
  //    where fleeting = entries with tier='fleeting' AND age > retention days
}
```

**`pebbl compact --preview`:**

1. Query all detail + fleeting entries from SQLite
2. Group by `(category, primary_topic, month)`:
   - primary_topic = first item in topics string (or 'general' if empty)
   - month = timestamp.slice(0, 7) → '2026-05'
3. For each group with count >= threshold, display:
```
[decision / auth / 2026-05] — 8 entries
  [id:5]  chose JWT for auth tokens
  [id:8]  switched from session to stateless
  [id:12] added refresh token rotation
  Proposed rollup: "Auth decisions May 2026: JWT chosen over sessions; refresh token rotation added."

AMBIGUOUS — 3 entries (no rubric match, need judgment):
  [id:22] "refactored the thing"  → signal / rollup / skip
  [id:25] "fixed that bug"        → signal / rollup / skip

FLEETING — 5 entries older than 30 days (will be deleted on execute)

Run: pebbl compact --execute
Resolve ambiguous: pebbl compact --execute --resolve 22:signal,25:rollup
```

**`pebbl compact --execute [--resolve id:action,...]`:**

Execution order: archive to disk first (safe — appending is idempotent), then modify
SQLite in a transaction. If the transaction fails, archive files have harmless extra
lines but no data is lost.

**Parse `--resolve` flag before doing anything else:**
```js
// Parse "22:signal,25:rollup" → Map { 22 => 'signal', 25 => 'rollup' }
// Valid actions: 'signal', 'rollup', 'skip'
// Invalid action → print error, exit 1 BEFORE any writes
// --resolve without --execute → print error, exit 1
// ID not found in db → print warning, skip that ID
// ID already categorized (not ambiguous) → print warning, skip that ID
```

Steps:
1. Build the same groups as `--preview` (reuse the grouping function)
2. Archive original entries to `.pebbl/archive/YYYY-MM.txt` (append, create file if needed)
3. Archive fleeting entries older than retention window to same archive files
4. Begin SQLite transaction:
   a. For each compactable group: INSERT rollup entry, DELETE originals
   b. Apply `--resolve` decisions:
      - `signal`: UPDATE tier='signal', category inferred from message or set to 'uncategorized'
      - `rollup`: DELETE from SQLite (already archived in step 2)
      - `skip`: no-op
   c. DELETE fleeting entries older than retention window
   d. Commit
5. Regenerate `manual-logs.md` from SQLite (full rebuild, ordered by timestamp ASC)
6. Call `qmdUpdate(pebblDir)`

On transaction failure: print error, exit 1. Archive files have extra lines but
SQLite is unchanged — next `--execute` run will re-archive (append is idempotent).

**Archive format** (`.pebbl/archive/YYYY-MM.txt`, plain text, append):
```
=== Archived 2026-05-23T14:00:00Z ===
[id:5] [signal|decision] topics:auth — chose JWT for auth tokens
[id:8] [detail|decision] topics:auth — switched from session to stateless
---
```

**Markdown regeneration** (after compaction):
```js
// Read all non-archived logs from SQLite ordered by timestamp ASC
// Write fresh manual-logs.md:
//   "# Manual Logs\n\n"
//   + for each entry:
//     "## {timestamp} - {message}\n"
//     "<!-- cat:{category} topic:{topics} tier:{tier} source:{source} -->\n\n"
```

**Verify Phase 5:**
- After 10+ detail entries on a topic, `pebbl compact --preview` shows the group
- `pebbl compact --execute` archives entries, creates rollup entry, re-indexes
- Archive file exists at `.pebbl/archive/YYYY-MM.txt` in plain text
- On simulated mid-execute failure, SQLite remains unchanged (transaction rolled back)
- Signal-tier entries never appear in compaction groups

---

### Phase 6 — AGENTS.md + eject

**Modify: `src/init.js`**

Replace AGENT_SECTION constant with:

```markdown
## Pebbl — Project Memory Protocol

Pebbl stores architecture decisions, conventions, and component facts for this codebase.
Agents use it to avoid burning tokens re-discovering what's already known.

### Start of every session
```bash
pebbl context                    # recent entries, all tiers
pebbl context --topic <area>     # entries for a specific component
pebbl search "topic" --cat decision  # search decisions before proposing an approach
```

### Logging (use --cat always)

| Category    | When to use |
|-------------|-------------|
| decision    | Choices made, rationale, constraints, trade-offs |
| structure   | Component boundaries, module topology, ownership |
| pattern     | Conventions, coding standards, design patterns |
| data        | Models, schemas, storage choices, data flow |
| integration | APIs, contracts, cross-component interfaces |
| quality     | Perf targets, SLAs, security posture |

```bash
pebbl log "message" --cat decision --topic auth
pebbl log "message" --cat structure --topic clipforge,hammy
pebbl log "message" --cat decision --tier signal  # force permanent tier
```

### End of every session
```bash
pebbl log "[session] one-line summary of what changed" --source agent --tier fleeting
```

### Correcting a past entry
```bash
pebbl log "new decision" --cat decision --corrects <id>
```

### Compaction (when notified)
```bash
pebbl compact --preview
pebbl compact --execute --resolve 12:signal,15:rollup,18:skip
```

### What to log
- Architecture decisions and why
- Component boundaries and ownership
- Conventions and patterns adopted
- Constraints and failed approaches

### What not to log
- Routine code changes (git hook captures those)
- Anything obvious from reading the code
```

**Modify: `src/eject.js`**

Update `startMarker` and `endMarker` strings to match the new AGENTS.md block.

**Verify Phase 6:**
- `pebbl init` on fresh project creates AGENTS.md with category table + session-end instruction
- `pebbl eject` removes the block cleanly
- `pebbl init` on existing project with old pebbl block replaces it (or appends if not found)

---

### Tests

**New directory: `test/`**

Use `node:test` (Node 18+ built-in). Run with: `node --test test/*.test.js`

`test/args.test.js` — cover:
- Flags with values
- Boolean flags (--preview, --execute)
- Mixed positional + flags
- Unknown flags passed through as positional

`test/rubric.test.js` — cover:
- Pattern matching → correct category/tier
- No match → null
- Explicit flag overrides rubric
- Missing rubric.yml → returns null gracefully

`test/migrate.test.js` — cover:
- New db: migration is a no-op
- Old db (no category column): all columns added, source normalized
- Idempotent: running twice doesn't error

`test/compact.test.js` — cover:
- Grouping logic (same category+topic+month groups together)
- Threshold: groups below threshold not included in preview
- Ambiguous entries (category=uncategorized) in separate section
- Fleeting entries older than retention window included for deletion

---

## File structure after v0.2

```
pebbl/
  bin/pebbl.js          ← updated: args passing, compact command
  src/
    args.js             ← new: flag parser
    db.js               ← updated: new schema, calls migrate
    migrate.js          ← new: ALTER TABLE migration
    rubric.js           ← new: YAML loader + classifyEntry
    log.js              ← updated: structured flags, rubric integration
    log-commit.js       ← updated: new fields
    search.js           ← updated: filtering, SQLite fallback
    context.js          ← updated: SQLite-based, filtering, notification
    compact.js          ← new: preview + execute
    init.js             ← updated: rubric.yml, config.yml, new AGENTS.md
    qmd.js              ← minor: no structural changes
    find-pebbl.js       ← unchanged
    eject.js            ← updated: new block markers
  test/
    args.test.js        ← new
    rubric.test.js      ← new
    migrate.test.js     ← new
    compact.test.js     ← new
```

## Phase order

```
Phase 1 (schema + args)  → verify → 
Phase 2 (structured log) → verify →
Phase 3 (rubric)   ─┐
                     ├─ can be done in parallel → verify →
Phase 4 (search)   ─┘
Phase 5 (compaction)     → verify →
Phase 6 (AGENTS.md)      → verify →
Tests (any phase, write alongside implementation)
```

**Do not start the next phase until verification steps for the current phase pass.**

---

## Engineering process (follow for every phase)

Each phase follows this sequence:
```
implement → write tests → run tests → verify manually → review → log → next
```

### Phase gate checklist (complete all before moving on)

1. **Tests pass.** Write tests alongside implementation, not after. Phase 1 ends with
   `test/args.test.js` + `test/migrate.test.js` passing. Phase 3 ends with
   `test/rubric.test.js` passing. Don't move on with red tests.

2. **Manual verification passes.** Run the verify steps listed in that phase's section.

3. **No broken windows.** If something passes tests but the code is ugly, the API
   feels awkward, or a name doesn't express intent — fix it now. Don't leave it
   for later cleanup. Bad code in Phase 2 becomes load-bearing by Phase 5.

4. **No duplication.** Check if you introduced duplicated constants, validation lists,
   or formatting logic. The category list (`decision`, `structure`, `pattern`, `data`,
   `integration`, `quality`) must live in ONE place and be imported everywhere.
   Same for tier list, source list, and entry formatting. Extract shared values to
   a constants or util module if needed.

5. **Each module does one thing.** If a file is doing two jobs, split it. Don't stuff
   the config.yml parser into rubric.js. Don't put grouping logic inline in
   compact.js's preview output function.

6. **Re-read previous phases.** If the current phase reveals a better way to structure
   earlier code, go back and refactor it. Small improvements compound. Don't
   only move forward.

7. **Log what you learned.** After each phase, run:
   ```bash
   pebbl log "[implementation note] ..." --cat decision --topic pebbl
   ```
   Log WHY things work the way they do when it's not obvious from the code.
   Don't log what you did — the diff shows that. Log what you discovered:
   gotchas, constraints, non-obvious behavior from dependencies.
