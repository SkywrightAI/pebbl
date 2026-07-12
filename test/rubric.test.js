'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadRubric, classifyEntry, classifyEntryMulti, atomicityOf, CATEGORY_PRIORITY, parseYaml, ensureProjectFiles } = require('../src/rubric');
describe('parseYaml', () => {
  it('parses rules list', () => {
    const yaml = `rules:
  - pattern: "chose|decided"
    category: decision
    tier: signal
  - pattern: "bug|fix"
    category: quality
    tier: detail
`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.rules.length, 2);
    assert.strictEqual(result.rules[0].pattern, 'chose|decided');
    assert.strictEqual(result.rules[0].category, 'decision');
    assert.strictEqual(result.rules[0].tier, 'signal');
  });

  it('parses flat key-value block', () => {
    const yaml = `compaction:
  threshold: 10
  fleeting_retention: 30
`;
    const result = parseYaml(yaml);
    assert.deepStrictEqual(result.compaction, { threshold: 10, fleeting_retention: 30 });
  });

  it('ignores comments and empty lines', () => {
    const yaml = `# This is a comment
rules:
  # Another comment
  - pattern: "test"
    category: decision
    tier: signal

`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.rules.length, 1);
    assert.strictEqual(result.rules[0].pattern, 'test');
  });

  it('strips quotes from values', () => {
    const yaml = `rules:
  - pattern: "chose"
    category: "decision"
    tier: 'signal'
`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.rules[0].category, 'decision');
    assert.strictEqual(result.rules[0].tier, 'signal');
  });

  it('rejects rules with no pattern (corrupt entries)', () => {
    // No pattern field → filtered out by loadRubric
    const yaml = `rules:
  - category: decision
    tier: signal
`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.rules.length, 1);
    // loadRubric will filter this out since pattern is missing
  });
});

describe('classifyEntry', () => {
  // Rules must match real rubric order: [session] first, then content patterns.
  // This ensures first-match-wins works correctly for session entries.
  const rules = [
    { pattern: new RegExp('\\[session\\]', 'i'), category: 'uncategorized', tier: 'fleeting' },
    { pattern: new RegExp('chose|decided|decision|picked', 'i'), category: 'decision', tier: 'component' },
    { pattern: new RegExp('module|component|boundary', 'i'), category: 'structure', tier: 'component' },
  ];

  it('matches decision keywords', () => {
    const result = classifyEntry(rules, 'chose SQLite over Postgres');
    assert.deepStrictEqual(result, { category: 'decision', tier: 'component' });
  });

  it('matches structure keywords', () => {
    const result = classifyEntry(rules, 'refactored the auth module boundary');
    assert.deepStrictEqual(result, { category: 'structure', tier: 'component' });
  });

  it('matches session tag', () => {
    const result = classifyEntry(rules, '[session] updated the API endpoints');
    assert.deepStrictEqual(result, { category: 'uncategorized', tier: 'fleeting' });
  });

  it('session entry with decision keywords still matches session rule first', () => {
    const result = classifyEntry(rules, '[session] we made a decision to use Redis and chose bcrypt');
    assert.deepStrictEqual(result, { category: 'uncategorized', tier: 'fleeting' });
  });

  it('returns null for no match', () => {
    const result = classifyEntry(rules, 'random note about nothing');
    assert.strictEqual(result, null);
  });

  it('returns null when rules array is empty', () => {
    const result = classifyEntry([], 'chose SQLite');
    assert.strictEqual(result, null);
  });

  it('uses first matching rule (order matters)', () => {
    const orderedRules = [
      { pattern: new RegExp('refactor|module', 'i'), category: 'structure', tier: 'component' },
      { pattern: new RegExp('refactor.*data', 'i'), category: 'data', tier: 'detail' },
    ];
    const result = classifyEntry(orderedRules, 'refactored the data module');
    assert.deepStrictEqual(result, { category: 'structure', tier: 'component' });
  });

  it('matches case-insensitively', () => {
    const result = classifyEntry(rules, 'DECIDED to use Redis');
    assert.deepStrictEqual(result, { category: 'decision', tier: 'component' });
  });
});

describe('classifyEntryMulti', () => {
  // Mirrors a slice of the default rubric's content rules. decision is highest
  // priority among these per CATEGORY_PRIORITY, then structure, then data.
  const rules = [
    { pattern: new RegExp('chose|decided', 'i'), category: 'decision', tier: 'component' },
    { pattern: new RegExp('module|component|boundary', 'i'), category: 'structure', tier: 'component' },
    { pattern: new RegExp('schema|model|table', 'i'), category: 'data', tier: 'detail' },
    { pattern: new RegExp('api|endpoint', 'i'), category: 'integration', tier: 'detail' },
  ];
  // A message that trips three distinct categories: decision + structure + data.
  const multiTopic = 'chose to refactor the auth module and change the schema';

  it('(a) is order-independent: same result regardless of rule order', () => {
    const forward = classifyEntryMulti(rules, multiTopic);
    const shuffled = classifyEntryMulti([rules[2], rules[3], rules[1], rules[0]], multiTopic);
    assert.deepStrictEqual(shuffled, forward);
    assert.deepStrictEqual(forward, {
      category: 'decision',
      categories: ['decision', 'structure', 'data'],
      tier: 'component',
    });
  });

  it('(b) returns ALL distinct matched categories for a multi-topic message', () => {
    const result = classifyEntryMulti(rules, multiTopic);
    assert.deepStrictEqual(result.categories, ['decision', 'structure', 'data']);
  });

  it('(c) primary == the CATEGORY_PRIORITY winner among matched categories', () => {
    const result = classifyEntryMulti(rules, multiTopic);
    const winner = result.categories
      .slice()
      .sort((a, b) => CATEGORY_PRIORITY.indexOf(a) - CATEGORY_PRIORITY.indexOf(b))[0];
    assert.strictEqual(result.category, winner);
    assert.strictEqual(result.category, 'decision');
  });

  it('(d) tier comes from the primary category\'s rule, not the first rule passed', () => {
    // data (tier detail) is listed first here; decision (tier component) is still
    // primary, so its tier must win — proving tier follows the primary not order.
    const reordered = [rules[2], rules[0], rules[1]]; // data, decision, structure
    const result = classifyEntryMulti(reordered, multiTopic);
    assert.strictEqual(result.category, 'decision');
    assert.strictEqual(result.tier, 'component');
  });

  it('(e) single-match stability: category === classifyEntry.category', () => {
    // Inline single-topic messages, each matching exactly one of `rules`.
    for (const msg of ['chose SQLite over Postgres',
                       'refactored the module boundary',
                       'added a column to the table',
                       'wired up a new API endpoint']) {
      const single = classifyEntry(rules, msg);
      const multi = classifyEntryMulti(rules, msg);
      assert.strictEqual(multi.categories.length, 1, `"${msg}" should match one rule`);
      assert.strictEqual(multi.category, single.category, `category mismatch for "${msg}"`);
      assert.strictEqual(multi.tier, single.tier, `tier mismatch for "${msg}"`);
    }
  });

  it('(e2) single-match stability holds against the real default rubric', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-multi-'));
    try {
      ensureProjectFiles(dir);
      const real = loadRubric(dir);
      for (const msg of ['chose Redis over Memcached',
                         'the legacy importer runs nightly',
                         'documented the API contract for webhooks']) {
        const single = classifyEntry(real, msg);
        const multi = classifyEntryMulti(real, msg);
        if (single === null) {
          assert.strictEqual(multi, null, `both null for "${msg}"`);
          continue;
        }
        // Where exactly one rule matches, the primary must equal first-match.
        if (multi.categories.length === 1) {
          assert.strictEqual(multi.category, single.category, `category mismatch for "${msg}"`);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(f) returns null when nothing matches', () => {
    assert.strictEqual(classifyEntryMulti(rules, 'random note about nothing'), null);
  });
});

describe('atomicityOf — the shared non-atomic predicate', () => {
  // Includes the [session] rule so the session/fleeting scoping can be exercised
  // directly (a [session] message resolves its primary to uncategorized).
  const rules = [
    { pattern: new RegExp('^\\[session\\]', 'i'), category: 'uncategorized', tier: 'fleeting' },
    { pattern: new RegExp('chose|decided', 'i'), category: 'decision', tier: 'component' },
    { pattern: new RegExp('module|component|boundary', 'i'), category: 'structure', tier: 'component' },
    { pattern: new RegExp('schema|model|table', 'i'), category: 'data', tier: 'detail' },
    { pattern: new RegExp('api|endpoint', 'i'), category: 'integration', tier: 'detail' },
  ];

  it('an atomic single-topic entry is NOT non-atomic (reason null)', () => {
    const a = atomicityOf(rules, 'chose SQLite over Postgres');
    assert.strictEqual(a.nonAtomic, false);
    assert.strictEqual(a.reason, null);
    assert.deepStrictEqual(a.categories, ['decision']);
  });

  it('>= 3 distinct categories is non-atomic, reason names the count + categories', () => {
    const a = atomicityOf(rules, 'chose to refactor the auth module and change the schema');
    assert.strictEqual(a.nonAtomic, true);
    assert.deepStrictEqual(a.categories, ['decision', 'structure', 'data']);
    assert.match(a.reason, /^3 categories: decision,structure,data$/);
  });

  it('the >= 2-categories-AND-long branch: short 2-cat is atomic, long 2-cat is not', () => {
    const short = 'chose to refactor the module'; // decision + structure, < 300 chars
    assert.strictEqual(atomicityOf(rules, short).nonAtomic, false);

    const long = short + ' '.repeat(310) + 'end'; // same 2 categories, > 300 chars
    const a = atomicityOf(rules, long);
    assert.strictEqual(a.nonAtomic, true);
    assert.deepStrictEqual(a.categories, ['decision', 'structure']);
    assert.match(a.reason, /^2 categories: decision,structure$/);
  });

  it('session/fleeting entries are ALWAYS atomic, even when they trip many rules', () => {
    // This message trips decision + structure + data + integration, but its
    // primary resolves to uncategorized via the [session] rule → atomic.
    const fat = '[session] chose to refactor the module, changed the schema, wired the api endpoint';
    const a = atomicityOf(rules, fat);
    assert.strictEqual(a.nonAtomic, false, 'a fat session log must never be flagged non-atomic');
    assert.strictEqual(a.reason, null);
  });

  it('a message matching no rule is atomic (nothing to split)', () => {
    const a = atomicityOf(rules, 'random note about nothing in particular');
    assert.strictEqual(a.nonAtomic, false);
    assert.strictEqual(a.reason, null);
    assert.deepStrictEqual(a.categories, []);
  });

  it('a [rollup] entry is ALWAYS atomic — the compactor made it multi-fact on purpose', () => {
    // Trips decision + structure + data + integration; a plain entry with this
    // message would be non-atomic. The rollup prefix (what compact.js's
    // generateRollupMessage writes) exempts it — doctor must not tell the
    // operator to split what compaction just joined.
    const rolled = '[rollup] decision notes on core (2026-Q3): chose to refactor the module; changed the schema; wired the api endpoint.';
    const a = atomicityOf(rules, rolled);
    assert.strictEqual(a.nonAtomic, false, 'a compaction rollup must never be flagged non-atomic');
    assert.strictEqual(a.reason, null);
  });
});

describe('loadRubric', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no rubric.yml exists', () => {
    const rules = loadRubric(tmpDir);
    assert.deepStrictEqual(rules, []);
  });

  it('loads and compiles rules from rubric.yml', () => {
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "chose|decided"
    category: decision
    tier: signal
  - pattern: "schema|model"
    category: data
    tier: detail
`);
    const rules = loadRubric(tmpDir);
    assert.strictEqual(rules.length, 2);
    assert(rules[0].pattern instanceof RegExp);
    assert(rules[1].pattern instanceof RegExp);
    assert(rules[0].pattern.test('I CHOSE Redis'));
    assert(!rules[0].pattern.test('added a table'));
    assert(rules[1].pattern.test('updated the schema'));
  });

  it('integration: file-loaded rules + classifyEntry pipeline', () => {
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "chose|decided"
    category: decision
    tier: signal
  - pattern: "api|endpoint"
    category: integration
    tier: detail
`);
    const rules = loadRubric(tmpDir);
    const result = classifyEntry(rules, 'chose Postgres over MySQL');
    assert.deepStrictEqual(result, { category: 'decision', tier: 'signal' });

    const result2 = classifyEntry(rules, 'added a new API endpoint');
    assert.deepStrictEqual(result2, { category: 'integration', tier: 'detail' });

    const result3 = classifyEntry(rules, 'random note');
    assert.strictEqual(result3, null);
  });

  it('filters out rules without pattern or category', () => {
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "chose"
    category: decision
    tier: signal
  - tier: signal
  - pattern: "data"
`);
    const rules = loadRubric(tmpDir);
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].category, 'decision');
  });
});

describe('ensureProjectFiles — rubric migration', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-migrate-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('anchors unanchored [session] pattern in existing rubric', () => {
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "\\[session\\]"
    category: uncategorized
    tier: fleeting
  - pattern: "chose|decided"
    category: decision
    tier: signal
`);
    ensureProjectFiles(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'rubric.yml'), 'utf8');
    assert(content.includes('^\\[session\\]'), 'pattern should be anchored with ^');
    assert(!content.includes('"\\[session\\]"'), 'old unanchored pattern should be gone');
  });

  it('does not double-anchor already anchored pattern', () => {
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "^\\[session\\]"
    category: uncategorized
    tier: fleeting
`);
    ensureProjectFiles(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'rubric.yml'), 'utf8');
    assert(!content.includes('^^'), 'should not double-anchor');
    assert(content.includes('^\\[session\\]'), 'anchored pattern preserved');
  });

  it('does not anchor-migrate rubrics without [session] pattern, but adds trace rule', () => {
    const original = `rules:
  - pattern: "chose|decided"
    category: decision
    tier: component
`;
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), original);
    ensureProjectFiles(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'rubric.yml'), 'utf8');
    assert(!content.includes('^^'), 'should not add double-anchor');
    assert(content.includes('^trace:'), 'trace rule should be added');
    assert(content.includes('chose|decided'), 'existing rules should be preserved');
  });

  it('adds "friction" to the steering rule AND renames correction -> steering in an existing rubric', () => {
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "parked|fail(ed)? (review|verdict|adversarial)|regression|incident"
    category: correction
    tier: detail
`);
    ensureProjectFiles(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'rubric.yml'), 'utf8');
    assert(content.includes('parked|friction|'), 'friction should be added to the steering rule');
    assert(content.includes('category: steering'), 'correction should be renamed to steering');
    assert(!content.includes('category: correction'), 'old correction category should be gone');
    // Idempotent: re-running adds nothing and renames nothing twice.
    ensureProjectFiles(tmpDir);
    const again = fs.readFileSync(path.join(tmpDir, 'rubric.yml'), 'utf8');
    assert.strictEqual((again.match(/friction/g) || []).length, 1, 'friction added exactly once');
    assert.strictEqual((again.match(/category: steering/g) || []).length, 1, 'steering rule present exactly once');

    // End to end: a friction log now classifies as steering.
    const rules = loadRubric(tmpDir);
    assert.deepStrictEqual(classifyEntry(rules, 'too much friction onboarding new repos'),
      { category: 'steering', tier: 'detail' });
  });

  it('v0.6: renames category correction -> steering in an existing rubric (idempotent)', () => {
    // friction already present, so only the v0.6 rename step should fire here.
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "parked|friction|regression"
    category: correction
    tier: detail
`);
    ensureProjectFiles(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'rubric.yml'), 'utf8');
    assert(content.includes('category: steering'), 'correction renamed to steering');
    assert(!content.includes('category: correction'), 'no correction category remains');
    assert.strictEqual((content.match(/friction/g) || []).length, 1, 'friction not duplicated');
    // Idempotent re-run: byte-for-byte no change.
    ensureProjectFiles(tmpDir);
    const again = fs.readFileSync(path.join(tmpDir, 'rubric.yml'), 'utf8');
    assert.strictEqual(again, content, 're-running migration is a no-op');

    // The renamed rule still classifies failure language as steering.
    const rules = loadRubric(tmpDir);
    assert.deepStrictEqual(classifyEntry(rules, 'regression in the ranker'),
      { category: 'steering', tier: 'detail' });
  });

  it('default rubric routes a friction log to steering', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-friction-'));
    try {
      ensureProjectFiles(fresh);
      const rules = loadRubric(fresh);
      assert.deepStrictEqual(classifyEntry(rules, 'this friction is killing the flow'),
        { category: 'steering', tier: 'detail' });
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});
