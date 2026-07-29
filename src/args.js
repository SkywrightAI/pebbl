'use strict';

const KNOWN_FLAGS = new Set([
  'cat', 'topic', 'source', 'tier', 'scope',
  'relates', 'corrects', 'preview', 'execute', 'resolve',
  'done', 'todo', 'blocked', 'docs', 'no-doc', 'latest', 'list', 'close',
  'open', 'list-open',
  'show', 'generate', 'include-archive', 'deep', 'n', 'refresh',
  'as-of', 'history', 'share', 'importance',
  'json', 'all', // doctor: machine-readable output; widen past conservative caps
  'strict', // log: FAIL (exit 1, store nothing) on a non-atomic multi-fact entry
  'metrics', // doctor: short-circuit to the quantitative atomicity scoreboard
]);

const BOOLEAN_FLAGS = new Set(['preview', 'execute', 'latest', 'list', 'close', 'open', 'list-open', 'show', 'generate', 'include-archive', 'deep', 'refresh', 'share', 'json', 'all', 'strict', 'metrics', 'no-doc']);

// Flags that may legitimately be given more than once. A repeat ACCUMULATES
// into an array instead of overwriting — the old behavior silently kept only the
// LAST occurrence, so `--done a --done b` dropped "a" without a peep (the bug
// that ate most of a handoff's items). The value is ALWAYS an array for these
// keys (even a single use), so consumers handle one shape. handoff.js's
// joinField folds the array back into the one ';'-separated string the table
// stores, so `--done "a; b"` and `--done a --done b` converge.
const MULTI_FLAGS = new Set(['done', 'todo', 'blocked']);

// Assign a parsed flag value, accumulating repeats for MULTI_FLAGS.
function setFlag(flags, key, value) {
  if (MULTI_FLAGS.has(key)) {
    (flags[key] || (flags[key] = [])).push(value);
  } else {
    flags[key] = value;
  }
}

// Flags whose value must be a positive integer (entry IDs). Used by the shared
// guard below so a non-numeric value errors loudly instead of silently storing
// NULL (parseInt('abc') === NaN, which SQLite coerces to NULL).
const INTEGER_FLAGS = new Set(['relates', 'corrects', 'n', 'history']);

function parseArgs(args) {
  const flags = {};
  const positional = [];
  // Known value-flags that had no usable following value (next token missing or
  // another --flag). Recorded here instead of silently dropped so a caller can
  // error via assertCompleteFlags() rather than losing the link (e.g. a dropped
  // --corrects leaves the contradicted entry live).
  const missingValueFlags = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--') && arg.length > 2) {
      // Split on the FIRST '=' so `--flag=value` parses into a flag, not literal
      // content. Values may themselves contain '=' (e.g. --resolve=a=b), which
      // the first-only split preserves.
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const hasInlineValue = eq !== -1;
      const key = hasInlineValue ? body.slice(0, eq) : body;
      const inlineValue = hasInlineValue ? body.slice(eq + 1) : undefined;

      if (!KNOWN_FLAGS.has(key)) {
        // Unknown flag: warn and pass through as positional (intentional — see
        // the pass-through test and context.js's raw --full demotion check).
        process.stderr.write(`pebbl: unknown flag ${arg} (ignored)\n`);
        positional.push(arg);
        continue;
      }

      if (BOOLEAN_FLAGS.has(key)) {
        // `--bool=false` / `--bool=0` turn the flag off; any other inline value
        // (or none) leaves it on. Without '=', it's simply true.
        if (hasInlineValue) {
          flags[key] = !(inlineValue === '' || inlineValue === 'false' || inlineValue === '0');
        } else {
          flags[key] = true;
        }
        continue;
      }

      if (hasInlineValue) {
        // Empty inline value (`--cat=`) counts as a missing value for a flag
        // that needs one.
        if (inlineValue === '') {
          missingValueFlags.push(key);
        } else {
          setFlag(flags, key, inlineValue);
        }
        continue;
      }

      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        setFlag(flags, key, next);
        i++;
      } else {
        // No usable value: record instead of silently dropping.
        missingValueFlags.push(key);
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional, missingValueFlags };
}

// Shared guard: error (exit 1) if any known value-flag was given without a
// value. Kept separate from parseArgs so parseArgs stays a pure, side-effect-
// free parser that callers can inspect; commands opt in to the hard stop.
function assertCompleteFlags(parsed) {
  const missing = parsed.missingValueFlags || [];
  if (missing.length > 0) {
    for (const key of missing) {
      console.error(`pebbl: --${key} expects a value`);
    }
    process.exit(1);
  }
}

// Shared guard: error (exit 1) if an integer flag holds a non-integer value.
// parseInt('abc') is NaN, which SQLite would store as NULL — a silent failure.
function assertIntegerFlags(parsed, keys = INTEGER_FLAGS) {
  const flags = parsed.flags || {};
  for (const key of keys) {
    const raw = flags[key];
    if (raw === undefined || raw === null) continue;
    if (!/^-?\d+$/.test(String(raw).trim())) {
      console.error(`pebbl: --${key} expects an integer, got "${raw}"`);
      process.exit(1);
    }
  }
}

module.exports = { parseArgs, assertCompleteFlags, assertIntegerFlags, INTEGER_FLAGS, MULTI_FLAGS };
