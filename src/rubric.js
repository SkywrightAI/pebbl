'use strict';
const fs = require('fs');
const path = require('path');
const { isRollupMessage } = require('./fold');

function parseYaml(content) {
  const lines = content.split('\n');
  const result = { rules: [] };
  let currentBlock = null;
  let currentItem = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;

    if (indent === 0 && !trimmed.startsWith('-')) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        currentBlock = trimmed.slice(0, colonIdx);
        result[currentBlock] = result[currentBlock] || {};
      }
      continue;
    }

    if (indent === 2 && trimmed.startsWith('-') && trimmed.includes(':')) {
      currentItem = {};
      result.rules.push(currentItem);
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        currentItem[trimmed.slice(2, colonIdx).trim()] = parseValue(trimmed.slice(colonIdx + 1).trim());
      }
      continue;
    }

    if (indent === 4 && currentItem) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        currentItem[trimmed.slice(0, colonIdx).trim()] = parseValue(trimmed.slice(colonIdx + 1).trim());
      }
      continue;
    }

    if (indent === 2 && currentBlock) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        result[currentBlock][trimmed.slice(0, colonIdx).trim()] = parseValue(trimmed.slice(colonIdx + 1).trim());
      }
      continue;
    }
  }

  return result;
}

function parseValue(raw) {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
}

function loadRubric(pebblDir) {
  const rubricPath = path.join(pebblDir, 'rubric.yml');
  if (!fs.existsSync(rubricPath)) return [];

  const raw = fs.readFileSync(rubricPath, 'utf8');
  const parsed = parseYaml(raw);
  const rules = (parsed.rules || []).map(r => ({
    pattern: r.pattern ? new RegExp(r.pattern, 'i') : null,
    category: r.category || null,
    tier: r.tier || null,
  })).filter(r => r.pattern && r.category);

  return rules;
}

function loadConfig(pebblDir) {
  const configPath = path.join(pebblDir, 'config.yml');
  if (!fs.existsSync(configPath)) return null;

  const raw = fs.readFileSync(configPath, 'utf8');
  return parseYaml(raw);
}

function classifyEntry(rules, message) {
  for (const rule of rules) {
    if (rule.pattern.test(message)) {
      return { category: rule.category, tier: rule.tier };
    }
  }
  return null;
}

// Fixed, highest-priority-first ordering of categories. This MIRRORS the
// content-rule order of DEFAULT_RUBRIC (the first appearance of each category,
// reading top to bottom), so the PRIMARY category classifyEntryMulti picks for a
// single matching rule is identical to what the order-dependent classifyEntry
// returns today (the stability invariant). It also means a multi-match entry on
// the default rubric resolves to the same category first-match would have, since
// priority == rule order there.
//
// Why have it at all: classifyEntry is order-dependent — reorder rubric.yml and
// the stored category for a multi-topic entry can silently change with rule
// position. CATEGORY_PRIORITY pins the choice to a category, not a line number,
// so a future rubric reordering can't quietly re-file existing entries. A small,
// free stability win (ETC — easier to change the rubric safely later).
const CATEGORY_PRIORITY = [
  'uncategorized',
  'quality',
  'steering',
  'decision',
  'structure',
  'pattern',
  'data',
  'integration',
];

// Tier durability, most durable first. Only used as a deterministic tie-break
// when ONE category is produced by more than one matched rule with different
// tiers (e.g. DEFAULT_RUBRIC has two `decision` rules: component and detail).
// Picking the most durable tier is order-independent — and on the default rubric
// it happens to match first-match's tier (decision -> component).
const TIER_DURABILITY = ['foundation', 'component', 'detail', 'fleeting'];

function categoryRank(cat) {
  const i = CATEGORY_PRIORITY.indexOf(cat);
  return i === -1 ? CATEGORY_PRIORITY.length : i; // unknown categories sort last
}

function tierRank(tier) {
  const i = TIER_DURABILITY.indexOf(tier);
  return i === -1 ? TIER_DURABILITY.length : i; // unknown tiers sort last
}

// Order-INDEPENDENT classifier. Where classifyEntry stops at the first matching
// rule (order matters), this scans ALL rules and reports every distinct category
// that matched, with a stable primary pick driven by CATEGORY_PRIORITY rather
// than rule position. Returns { category, categories, tier } or null when
// nothing matches (mirrors classifyEntry's null contract).
//   - categories: distinct matched categories, sorted by CATEGORY_PRIORITY
//     (alphabetical tie-break for any category outside the priority list).
//   - category:   the primary = categories[0] = highest-priority match. This is
//     the single category we'd store; it equals classifyEntry's category for any
//     single-rule match (the stability invariant).
//   - tier:       the tier of the matched rule that produced the primary; if
//     several rules produced it with different tiers, the most durable wins.
// classifyEntry is intentionally left untouched (its pinned tests depend on
// first-match); this is a NEW additive scorer used by `pebbl doctor` to spot
// multi-topic ("non-atomic") entries without changing the write path.
function classifyEntryMulti(rules, message) {
  // category -> tier of the most-durable matched rule for that category.
  const tierByCategory = new Map();
  for (const rule of rules) {
    if (rule.pattern && rule.pattern.test(message)) {
      const prev = tierByCategory.get(rule.category);
      if (prev === undefined || tierRank(rule.tier) < tierRank(prev)) {
        tierByCategory.set(rule.category, rule.tier);
      }
    }
  }
  if (tierByCategory.size === 0) return null;

  const categories = [...tierByCategory.keys()].sort((a, b) =>
    (categoryRank(a) - categoryRank(b)) || (a < b ? -1 : a > b ? 1 : 0));
  const category = categories[0];
  const tier = tierByCategory.get(category);
  return { category, categories, tier };
}

// The ONE shared atomicity predicate. An atomic memory is one fact per row; a
// non-atomic ("multi-topic") entry crams several facts into a single `pebbl log`
// so the rubric files it under ONE category while the other facts hide. This is
// the single definition of "non-atomic" that BOTH `pebbl doctor` (report-only)
// and `pebbl log --strict` (write-time enforcement) key on, so the threshold
// lives in exactly one place — retune it here and both callers move together
// (DRY: one definition, no drift between detect and enforce).
//
// Returns { categories, nonAtomic, reason }:
//   - categories: classifyEntryMulti's distinct matched set (priority-sorted).
//   - nonAtomic:  categories.length >= 3, OR (categories.length >= 2 AND the
//                 message is long, > 300 chars — a long entry straddling two
//                 topics is probably two entries).
//   - reason:     a short machine/human string, e.g. "3 categories: a,b,c", or
//                 null when atomic.
//
// SCOPING — fleeting/uncategorized entries are ALWAYS atomic (nonAtomic:false).
// Session/heartbeat logs ([session] -> uncategorized/fleeting) are deliberately
// NOT memory facts (one-fact-per-row doesn't apply to a session summary), so
// --strict must never refuse them or it would break loom's session logging. This
// also kills a false positive the detector had on "fat" session logs that trip
// several content rules. A message that matches no rule is atomic too (nothing
// to split). Reuses classifyEntryMulti — no second scorer.
//
// [rollup] entries are ALWAYS atomic too. A rollup is the COMPACTOR'S OWN
// OUTPUT — generateRollupMessage deliberately concatenates many source
// messages into one row, so it trips several categories by construction.
// Flagging it tells the operator to split what compaction just joined (the
// tool fighting its own compactor). The marker is the same `[rollup] ` prefix
// compact.js writes (generateRollupMessage) and strips when re-rolling, so
// there is one definition of "this row is a rollup". Side effect on --strict:
// a hand-logged "[rollup] ..." message also passes — acceptable; the prefix
// is a machine marker no honest write path uses.
function atomicityOf(rules, message) {
  const m = classifyEntryMulti(rules, message);
  if (!m) return { categories: [], nonAtomic: false, reason: null };
  const categories = m.categories;
  // Session/fleeting/uncategorized entries are not memory facts — never refuse.
  // (uncategorized is the highest-priority category, so a [session] entry that
  // also trips content rules still resolves its primary to uncategorized.)
  if (m.category === 'uncategorized' || m.tier === 'fleeting') {
    return { categories, nonAtomic: false, reason: null };
  }
  // Compaction rollups are multi-fact by construction — never flag them. The
  // predicate is shared with readback (fold.isRollupMessage) so the writer and
  // every reader agree on what a rollup is.
  if (isRollupMessage(message)) {
    return { categories, nonAtomic: false, reason: null };
  }
  const len = String(message || '').length;
  const nonAtomic = categories.length >= 3 || (categories.length >= 2 && len > 300);
  const reason = nonAtomic ? `${categories.length} categories: ${categories.join(',')}` : null;
  return { categories, nonAtomic, reason };
}

module.exports = { loadRubric, loadConfig, classifyEntry, classifyEntryMulti, atomicityOf, CATEGORY_PRIORITY, parseYaml };

const DEFAULT_RUBRIC = `# Pebbl classification rubric — edit to tune auto-tagging
# Rules are evaluated top-to-bottom; first match wins.
# Pattern is matched case-insensitively against the entry message.

rules:
  - pattern: "^\\[session\\]"
    category: uncategorized
    tier: fleeting

  - pattern: "^trace:"
    category: quality
    tier: detail

  - pattern: "parked|friction|fail(ed)? (review|verdict|adversarial)|verdict: fail|regression|hotfix|incident|crashed|post-?mortem"
    category: steering
    tier: detail

  - pattern: "chose|decided|decision|picked|went with|trade-?off|constraint|switched|replaced|changed to|adopted|rejected|dropped|reverted|migrated"
    category: decision
    tier: component

  - pattern: "module|component|boundary|owns|ownership|depends on|architecture"
    category: structure
    tier: component

  - pattern: "convention|pattern|standard|always|never|rule:|style"
    category: pattern
    tier: component

  - pattern: "schema|model|table|column|migration|data flow|storage"
    category: data
    tier: detail

  - pattern: "api|endpoint|contract|integration|webhook|external"
    category: integration
    tier: detail

  - pattern: "perf|latency|SLA|security|posture|target|benchmark"
    category: quality
    tier: detail

  - pattern: "\\b(default|threshold|weight|score\\b|blend|config|param|formula)\\b.{0,20}\\d+\\.?\\d*"
    category: decision
    tier: detail
`;

const DEFAULT_CONFIG = `compaction:
  threshold: 10
  fleeting_retention: 30
sources:
  dirs: sources
`;

// Byte offset just past the end of the top-level `rules:` line, or -1 if the
// rubric has no such line. Every rule insertion anchors off this so a new rule
// can never land ABOVE `rules:` (see moveStrayRulesUnderRulesKey).
function endOfRulesKey(content) {
  const m = /^rules:[ \t]*$/m.exec(content);
  if (!m) return -1;
  return m.index + m[0].length;
}

// Insert a rule block into an existing rubric, below `rules:`.
//
// Anchor preference, highest first:
//   1. after the `[session]` rule — it must stay FIRST-match, because it tiers
//      whole session dumps as fleeting and the rules below it are unanchored
//      keyword patterns that would otherwise claim a session dump mentioning
//      e.g. "regression".
//   2. after the first rule below `rules:` — keeps a hand-written lead rule lead.
//   3. immediately after `rules:` — rubric has no rules yet.
// Returns the content unchanged if there is no `rules:` line (a rubric that
// malformed is the operator's to fix, not ours to guess at).
function insertRule(content, ruleBlock) {
  const rulesEnd = endOfRulesKey(content);
  if (rulesEnd === -1) return content;
  // Matches the pattern whether or not the brackets are backslash-escaped.
  const session = /^[ \t]+- pattern:.*\\?\[session\\?\].*$/m.exec(content);
  const anchorFrom = session && session.index > rulesEnd
    ? session.index + session[0].length
    : rulesEnd + 1;
  const blockEnd = content.indexOf('\n\n', anchorFrom);
  const insertAt = blockEnd !== -1 ? blockEnd : rulesEnd;
  return content.slice(0, insertAt) + ruleBlock + content.slice(insertAt);
}

// v0.8 repair: earlier versions of the v0.4 `^trace:` step anchored on the
// literal text "[session]", which does not appear in a rubric whose pattern is
// escaped ("^\[session\]"). indexOf returned -1, the insertion point collapsed
// to the first blank line in the file, and the rule was written ABOVE the
// `rules:` key. pebbl's own lenient parser still reads such a rule, so nothing
// broke visibly — but the file is no longer valid YAML, so any real YAML parser
// would reject it. Move stray rules back under `rules:` in file order.
function moveStrayRulesUnderRulesKey(content) {
  const rulesEnd = endOfRulesKey(content);
  if (rulesEnd === -1) return { content, moved: 0 };
  const rulesLineStart = content.lastIndexOf('\n', rulesEnd - 'rules:'.length) + 1;
  const head = content.slice(0, rulesLineStart);
  const tail = content.slice(rulesLineStart);

  // A stray block starts at an indented "- pattern:" line and runs to the next
  // blank line (or end of head).
  const strayBlock = /^[ \t]+- pattern:.*(?:\n(?![ \t]*$)[ \t]+.*)*\n?/gm;
  const stray = head.match(strayBlock);
  if (!stray) return { content, moved: 0 };

  let cleanedHead = head.replace(strayBlock, '');
  // Collapse the run of blank lines the removal leaves behind.
  cleanedHead = cleanedHead.replace(/\n{3,}/g, '\n\n');
  let rebuilt = cleanedHead + tail;
  for (const block of stray.reverse()) {
    rebuilt = insertRule(rebuilt, '\n\n' + block.replace(/\n+$/, ''));
  }
  return { content: rebuilt, moved: stray.length };
}

function migrateRubric(pebblDir) {
  const rubricPath = path.join(pebblDir, 'rubric.yml');
  if (!fs.existsSync(rubricPath)) return;

  let content = fs.readFileSync(rubricPath, 'utf8');
  let sessionMigrated = false;
  let decisionMigrated = false;

  // v0.2.1: anchor [session] pattern to start of message.
  // Old pattern matched [session] mid-text, causing entries like
  // "the [session] token expires" to get fleeting tier.
  const oldPattern = /pattern:\s*["']\\?\[session\\?\]["']/;
  const anchoredPattern = /pattern:\s*["']\^\\?\[session\\?\]["']/;
  if (oldPattern.test(content) && !anchoredPattern.test(content)) {
    content = content.replace(oldPattern, (match) => {
      // Insert ^ anchor after the opening quote
      return match.replace(/["']\\?\[/, (m) => m[0] + '^' + m.slice(1));
    });
    sessionMigrated = true;
  }

  // v0.2.2: expand decision keywords.
  // Old pattern lacked common agent verbs like switched, adopted, rejected, etc.
  const oldDecision = 'chose|decided|decision|picked|went with|trade-?off|constraint';
  const expandedDecision = 'chose|decided|decision|picked|went with|trade-?off|constraint|switched|replaced|changed to|adopted|rejected|dropped|reverted|migrated';
  if (content.includes(oldDecision) && !content.includes('switched|replaced|changed to|adopted')) {
    content = content.replace(oldDecision, expandedDecision);
    decisionMigrated = true;
  }

  // v0.3: rename tier: signal → tier: component
  let signalMigrated = false;
  if (content.includes('tier: signal') && !content.includes('tier: component')) {
    content = content.replace(/tier:\s*signal/g, 'tier: component');
    signalMigrated = true;
    console.error('pebbl: migrated rubric.yml (signal → component tier)');
  }

  // v0.4: add ^trace: rule for auto-classification of success traces.
  // Anchored via insertRule so the rule always lands under `rules:` — the old
  // "[session]"-literal anchor missed escaped patterns and wrote above the key.
  let traceMigrated = false;
  if (!content.includes('^trace:')) {
    const traceRule = '\n\n  - pattern: "^trace:"\n    category: quality\n    tier: detail';
    const next = insertRule(content, traceRule);
    if (next !== content) {
      content = next;
      traceMigrated = true;
      console.error('pebbl: migrated rubric.yml (added ^trace: rule)');
    }
  }

  // v0.5: add "friction" to the steering rule (named "correction" before v0.6)
  // so "pebbl log this friction" routes there without a manual --cat. This step
  // matches the pre-rename string `category: correction`, so it MUST run BEFORE
  // the v0.6 rename below — renaming first would make this guard miss.
  let frictionMigrated = false;
  if (content.includes('category: correction') && !/\bfriction\b/.test(content) && content.includes('parked|')) {
    content = content.replace('parked|', 'parked|friction|');
    frictionMigrated = true;
    console.error('pebbl: migrated rubric.yml (added "friction" to steering rule)');
  }

  // v0.6: rename the category `correction` -> `steering` in an existing rubric.
  // "steering" reads as course-correction/guidance (broader, more intuitive) and
  // the rule now also catches "friction". ORDER MATTERS: runs AFTER the v0.5
  // friction step (whose guard matches the pre-rename string). Idempotent: once
  // renamed there is no `category: correction` left, so a re-run is a no-op.
  let correctionRenamed = false;
  if (content.includes('category: correction')) {
    content = content.replace(/category:(\s*)correction\b/g, 'category:$1steering');
    correctionRenamed = true;
    console.error('pebbl: migrated rubric.yml (renamed category correction -> steering)');
  }

  // v0.7: insert the steering rule when it is ABSENT.
  // The v0.5/v0.6 steps above only edit a steering rule that already exists, so
  // rubrics written before the rule shipped never gained it — friction,
  // regressions and parked work in those stores fell through to whatever rule
  // matched next (usually none) and had to be hand-tagged with --cat forever.
  let steeringAdded = false;
  if (!/category:\s*steering\b/.test(content)) {
    const steeringRule = '\n\n  - pattern: "parked|friction|fail(ed)? (review|verdict|adversarial)|verdict: fail|regression|hotfix|incident|crashed|post-?mortem"\n    category: steering\n    tier: detail';
    // Anchor below ^trace: when present so rule order matches DEFAULT_RUBRIC.
    const traceIdx = content.indexOf('^trace:');
    let next;
    if (traceIdx !== -1) {
      const traceEnd = content.indexOf('\n\n', traceIdx);
      next = traceEnd !== -1
        ? content.slice(0, traceEnd) + steeringRule + content.slice(traceEnd)
        : content.replace(/\n*$/, steeringRule + '\n');
    } else {
      next = insertRule(content, steeringRule);
    }
    if (next !== content) {
      content = next;
      steeringAdded = true;
      console.error('pebbl: migrated rubric.yml (added missing steering rule)');
    }
  }

  // v0.8: repair rules stranded above the `rules:` key by the old v0.4 anchor.
  const { content: repaired, moved } = moveStrayRulesUnderRulesKey(content);
  let strayMoved = false;
  if (moved > 0) {
    content = repaired;
    strayMoved = true;
    console.error(`pebbl: migrated rubric.yml (moved ${moved} stray rule(s) under rules:)`);
  }

  if (sessionMigrated) {
    console.error('pebbl: migrated rubric.yml (anchored [session] pattern)');
  }
  if (decisionMigrated) {
    console.error('pebbl: migrated rubric.yml (expanded decision keywords)');
  }
  if (sessionMigrated || decisionMigrated || signalMigrated || traceMigrated || frictionMigrated || correctionRenamed || steeringAdded || strayMoved) {
    fs.writeFileSync(rubricPath, content);
  }
}

function ensureProjectFiles(pebblDir) {
  const rubricPath = path.join(pebblDir, 'rubric.yml');
  if (!fs.existsSync(rubricPath)) {
    fs.writeFileSync(rubricPath, DEFAULT_RUBRIC);
  } else {
    migrateRubric(pebblDir);
  }

  const configPath = path.join(pebblDir, 'config.yml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, DEFAULT_CONFIG);
  }
}

module.exports.DEFAULT_RUBRIC = DEFAULT_RUBRIC;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports.ensureProjectFiles = ensureProjectFiles;
