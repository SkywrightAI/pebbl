# Pebbl v0.2 — Post-Implementation Fixes

You are fixing bugs and test gaps in pebbl v0.2. The source repo is at `/Users/ashley/Documents/pebbl`.
Read each file mentioned before modifying it. Run `node --test test/*.test.js` after every change.

---

## Bug 1: v0.1 projects missing rubric.yml + config.yml after migration

**What's broken:** When a project initialized with pebbl v0.1 runs any v0.2 command,
`migrate.js` adds the new SQLite columns but doesn't create `rubric.yml` or `config.yml`.
Without `rubric.yml`, auto-classification is silently disabled — every entry without
`--cat` becomes `uncategorized`. This is the highest-priority fix.

**Where:** `src/db.js` — `openDb()` is the entry point for every command.

**Fix:** After calling `migrate(db)`, check if `rubric.yml` exists in `pebblDir`. If not,
write the default rubric (same content that `init.js` writes). Same for `config.yml`.

Extract the default rubric and config content from `init.js` into a shared location so
both `init.js` and `db.js` use the same defaults. Don't duplicate the strings.

**Important:** `openDb(pebblDir)` currently only takes the pebbl directory path and only
does database work. You'll need to either:
- (a) Have `openDb` also handle file seeding (simplest — it already knows `pebblDir`), or
- (b) Create an `ensureProjectFiles(pebblDir)` function called alongside `openDb` in the
  commands that need it.

Option (b) is cleaner — `openDb` stays focused on the database, and file concerns stay
separate. Put `ensureProjectFiles` in a new file or in `init.js` and call it from `log.js`,
`search.js`, `context.js`, and `compact.js` — the four commands that need rubric/config.

**Verify:** 
```bash
# Simulate a v0.1 project (no rubric.yml, no config.yml)
mkdir /tmp/pebbl-test && cd /tmp/pebbl-test && git init
pebbl init
rm .pebbl/rubric.yml .pebbl/config.yml
pebbl log "chose Redis" 
# Should auto-classify as decision/signal, NOT uncategorized
```

---

## Bug 2: Dead code in compact.js

**Where:** `src/compact.js`, line 179

```js
if (resolveMap.size > 0 && !resolveRaw) {
  console.error('--resolve requires --execute');
  process.exit(1);
}
```

**Why it's dead:** `parseResolve(undefined)` returns an empty Map (size 0), so the
condition `resolveMap.size > 0 && !resolveRaw` can never be true.

**Fix:** Delete these 4 lines.

---

## Bug 3: Topic SQL filter duplicated 3 times (DRY violation)

**Where:** The exact same SQL fragment appears in:
- `src/context.js` line 21-22
- `src/context.js` line 55
- `src/search.js` line 54-56

The pattern:
```sql
AND (',' || topics || ',' LIKE ? OR topics = ? OR topics LIKE ? || ',' OR topics LIKE ',' || ?)
```
with params `[%,${topic},%, topic, topic, topic]`.

**Fix:** Create a helper function (put it in a shared util or in `db.js`):
```js
function topicFilter(topic) {
  return {
    clause: "AND (',' || topics || ',' LIKE ? OR topics = ? OR topics LIKE ? || ',' OR topics LIKE ',' || ?)",
    params: [`%,${topic},%`, topic, topic, topic],
  };
}
```

Import and use it in `context.js` and `search.js`. The function returns a clause string
and params array that get appended to the existing query.

---

## Bug 4: log-commit entries pile up as uncategorized

**Where:** `src/log-commit.js` line 28-30

```js
db.prepare(`
  INSERT INTO logs (timestamp, source, category, tier, message, topics)
  VALUES (?, 'hook', 'uncategorized', 'fleeting', ?, NULL)
`).run(ts, msg);
```

Commits are always `uncategorized` regardless of rubric. They pile up in compaction
preview as ambiguous entries needing manual `--resolve`.

**Fix:** Load the rubric and classify the commit message, same as `log.js` does.
If no match, leave as `uncategorized` (which is fine — commits are inherently fleeting
and will age out). The key is that commits with decision-like messages ("chose X",
"decided Y") get properly classified.

```js
const { loadRubric, classifyEntry } = require('./rubric');
// ...inside logCommit, after getting pebblDir:
const rules = loadRubric(pebblDir);
const classified = classifyEntry(rules, msg);
const category = classified ? classified.category : 'uncategorized';
const tier = 'fleeting'; // always fleeting for auto-captured commits
```

---

## Test gaps to fill

### Test A: Integration test for auto-classification (in `test/rubric.test.js`)

Add a test that creates a temp dir with `rubric.yml`, then calls `classifyEntry` via
`loadRubric` and verifies the full pipeline. The existing tests use hardcoded rule
objects — this test should use the file.

```js
it('loadRubric + classifyEntry integration: file-loaded rules classify correctly', () => {
  // write rubric.yml to tmpDir (already done in existing loadRubric tests)
  const rules = loadRubric(tmpDir);
  const result = classifyEntry(rules, 'chose Postgres over MySQL');
  assert.deepStrictEqual(result, { category: 'decision', tier: 'signal' });
});
```

### Test B: Migration seeds missing files (new test in `test/migrate.test.js`)

```js
it('ensureProjectFiles creates rubric.yml and config.yml if missing', () => {
  const dir = tmpDir();
  // dir exists but has no rubric.yml or config.yml
  ensureProjectFiles(dir);
  assert(fs.existsSync(path.join(dir, 'rubric.yml')));
  assert(fs.existsSync(path.join(dir, 'config.yml')));
});

it('ensureProjectFiles does not overwrite existing rubric.yml', () => {
  const dir = tmpDir();
  const custom = 'rules:\n  - pattern: "custom"\n    category: quality\n    tier: signal\n';
  fs.writeFileSync(path.join(dir, 'rubric.yml'), custom);
  ensureProjectFiles(dir);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'rubric.yml'), 'utf8'), custom);
});
```

### Test C: Compact execute test (in `test/compact.test.js`)

Add a test for the execute path. This needs a temp `.pebbl/` directory with a db
and enough entries to trigger grouping:

```js
it('executeMode archives entries and creates rollup in SQLite', () => {
  // 1. Create temp dir, set up db with 10+ detail entries on same category/topic/month
  // 2. Write rubric.yml and config.yml (threshold: 5)
  // 3. Call compact's execute logic
  // 4. Assert: archive file exists in archive/ dir
  // 5. Assert: original entries deleted from SQLite
  // 6. Assert: rollup entry inserted with [rollup] prefix
  // 7. Assert: manual-logs.md regenerated
});
```

Note: `compact.js` exports the module function, not `executeMode` directly. You'll either
need to export `executeMode` for testing, or test via `buildGroups` + verifying the
archive/SQLite state after calling the main function with mocked args. The cleanest
approach is to export the helpers (`archiveEntries`, `regenerateMarkdown`, `buildGroups`,
`generateRollupMessage`) and test them individually — `buildGroups` is already exported
and tested.

### Test D: Topic filter helper (new test, wherever you put the helper)

```js
it('topicFilter returns correct SQL clause and params', () => {
  const { clause, params } = topicFilter('auth');
  assert(clause.includes('LIKE'));
  assert.strictEqual(params.length, 4);
  assert.strictEqual(params[0], '%,auth,%');
  assert.strictEqual(params[1], 'auth');
});
```

---

## Order of operations

1. Extract shared defaults from `init.js` (rubric content, config content)
2. Create `ensureProjectFiles` + topic filter helper
3. Fix `db.js` or callers to seed missing files (Bug 1)
4. Delete dead code in `compact.js` (Bug 2)
5. Replace duplicated topic SQL in `context.js` and `search.js` (Bug 3)
6. Fix `log-commit.js` to use rubric (Bug 4)
7. Add all tests (A, B, C, D)
8. Run `node --test test/*.test.js` — all must pass

---

## Rules

- Don't add new dependencies
- CommonJS throughout
- Don't change the CLI interface or flag names
- Don't modify test infrastructure (keep using `node:test`)
- Keep the existing tests passing — don't delete or weaken any
- When extracting shared code, put it where it makes sense architecturally (one module, one job)
- Run tests after every file change, not just at the end
