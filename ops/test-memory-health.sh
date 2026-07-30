#!/bin/bash
# Prove the health check DETECTS each invariant, and REPAIRS the ones it claims
# to repair. A monitor that has only ever returned green is indistinguishable
# from one that cannot fail, and a repairer that has never repaired is
# indistinguishable from one that cannot repair. So break each invariant on
# purpose and assert:
#
#   1. --verify-only reports it as FAIL   (detection works)
#   2. for a repairable one, a normal run reports FIXED and the invariant is
#      genuinely restored afterwards
#
# Everything is restored in a trap, so aborting mid-test cannot leave the live
# pipeline broken.
#
# Moved here from dev-tools/bin on 2026-07-30 with the store it tests. The three
# old `store-symlink` probes are gone: the store is a real directory in this
# repo now, so the invariant they proved is inverted. `store-inrepo` replaces
# them and is REPORT-ONLY on purpose — a symlink appearing there means a second
# store exists with history in it, and silently relinking would strand that
# history where nothing looks for it.
set -uo pipefail

REPO="/Users/ashley/pebbl"
LIVE="$REPO/.pebbl"
STORE="$LIVE"
CHECK="$REPO/ops/check-memory-health.sh"
LABEL="com.ashley.pebbl-memory"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DECOY="/tmp/pebbl-health-test-decoy-$$"

pass=0
fail=0

restore() {
  # If a probe left the store as a symlink, put the real directory back.
  if [ -L "$STORE" ]; then
    rm -f "$STORE"
    [ -d "$DECOY/real" ] && mv "$DECOY/real" "$STORE"
  fi
  rm -rf "$DECOY" 2>/dev/null
  case "$(launchctl list 2>/dev/null || true)" in
    *"$LABEL"*) : ;;
    *) launchctl load "$PLIST" 2>/dev/null ;;
  esac
  git -C "$REPO" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1 || \
    git -C "$REPO" branch --set-upstream-to=origin/main main >/dev/null 2>&1
  git -C "$REPO" reset -q HEAD -- "$LIVE/db.sqlite" 2>/dev/null
}
trap restore EXIT INT TERM

note() { printf '%-9s %-15s %s\n' "$1" "$2" "$3"; }

# Detection only, for the invariants that are deliberately not auto-repaired.
# $1 probe name, $2 description
detects() {
  local probe="$1" desc="$2" out
  # The check EXITS 1 when something is broken, which is the whole point here.
  # Capture first and grep the variable: piping straight into grep would let
  # `set -o pipefail` fail the pipeline on the check's exit code and throw away
  # a perfectly good match.
  out=$("$CHECK" --verify-only 2>&1) || true
  if printf '%s\n' "$out" | grep -qE "^FAIL  +$probe "; then
    note DETECTED "$probe" "$desc"
    pass=$((pass + 1))
  else
    note MISSED "$probe" "$desc"
    printf '%s\n' "$out" | sed 's/^/            /'
    fail=$((fail + 1))
  fi
}

# Detection + repair + verification, for the invariants the check does repair.
# $1 probe name, $2 description, $3 a command asserting the invariant is restored
cycle() {
  local probe="$1" desc="$2" assert="$3" out

  out=$("$CHECK" --verify-only 2>&1) || true
  if printf '%s\n' "$out" | grep -qE "^FAIL  +$probe "; then
    note DETECTED "$probe" "$desc"
    pass=$((pass + 1))
  else
    note MISSED "$probe" "$desc"
    printf '%s\n' "$out" | sed 's/^/            /'
    fail=$((fail + 1))
    return
  fi

  out=$("$CHECK" 2>&1) || true
  if printf '%s\n' "$out" | grep -qE "^FIXED +$probe "; then
    note REPAIRED "$probe" "$desc"
    pass=$((pass + 1))
  else
    note NOFIX "$probe" "$desc"
    printf '%s\n' "$out" | sed 's/^/            /'
    fail=$((fail + 1))
    return
  fi

  if eval "$assert"; then
    note VERIFIED "$probe" "invariant genuinely restored"
    pass=$((pass + 1))
  else
    note BOGUS "$probe" "reported FIXED but the invariant is still broken"
    fail=$((fail + 1))
  fi
}

echo "=== baseline ==="
if "$CHECK" --verify-only >/dev/null 2>&1; then
  note OK baseline "clean before we start"
  pass=$((pass + 1))
else
  note ABORT baseline "already failing — fix that before trusting this test"
  "$CHECK" --verify-only | sed 's/^/            /'
  exit 1
fi

echo
echo "=== detect (+ repair where claimed), per invariant ==="

# The store turned back into a symlink — memory being written outside the repo,
# unversioned. Report-only: relinking would strand whatever history the other
# store holds.
mkdir -p "$DECOY"
mv "$STORE" "$DECOY/real"
ln -sfn "$DECOY/real" "$STORE"
detects store-inrepo "store replaced by a symlink (memory written outside the repo)"
rm -f "$STORE"; mv "$DECOY/real" "$STORE"

# The amnesia failure (store silently reads EMPTY) can no longer be induced on
# the LIVE store, and that is the point of the move rather than a gap in the
# test. storeMode's step 4 asks git whether events.jsonl is ignored, and
# `git check-ignore` does not report TRACKED paths — so once events.jsonl is
# tracked, no gitignore regression can push this store back to the db.sqlite
# path it does not keep. Proving it on a SYNTHETIC store instead keeps the
# detector honest without mutilating the real one.
if node -e '
  const fs=require("fs"),os=require("os"),path=require("path");
  const d=fs.mkdtempSync(path.join(os.tmpdir(),"pebbl-mode-"));
  fs.writeFileSync(path.join(d,"events.jsonl"),"");          // present, but
  // no .events-canonical, no legacy-db.sqlite, and not a git repo at all, so
  // the git probe returns unknown -> the SAFE direction.
  const m=require("/Users/ashley/pebbl/src/store-mode").storeMode(d);
  process.exit(m==="legacy"?0:1);
' 2>/dev/null; then
  note VERIFIED store-mode "an unmarked, unshared store still classifies legacy (detector works)"
  pass=$((pass + 1))
else
  note BOGUS store-mode "storeMode failed to classify an unmarked store as legacy"
  fail=$((fail + 1))
fi

if [ -f "$LIVE/.events-canonical" ]; then
  note OK store-mode "live store carries the completeness marker AND a tracked events.jsonl"
  pass=$((pass + 1))
else
  note BAD store-mode "the live completeness marker is missing"
  fail=$((fail + 1))
fi

# Scheduled job unloaded.
launchctl unload "$PLIST" 2>/dev/null
# No pipe at all: any `producer | grep -q` gives the producer SIGPIPE when grep
# exits on the first match, which `set -o pipefail` then reports as failure. A
# case-glob match reads the same and cannot short-circuit anything.
cycle launchd "scheduled job unloaded" \
  'case "$(launchctl list 2>/dev/null || true)" in *"$LABEL"*) true;; *) false;; esac'

# Upstream tracking lost.
git -C "$REPO" branch --unset-upstream 2>/dev/null
cycle unpushed "upstream tracking removed" \
  'git -C "$REPO" rev-parse --abbrev-ref "@{upstream}" >/dev/null 2>&1'

# A derived file tracked (gitignore regression).
# Staged only — `git ls-files` reads the index, so forcing it there is a faithful
# fault without inventing a commit the repo history has to carry forever.
git -C "$REPO" add -f .pebbl/db.sqlite >/dev/null 2>&1
cycle tracked-set "a derived file got tracked" \
  '[ -z "$(git -C "$REPO" ls-files .pebbl/db.sqlite)" ]'

echo
echo "=== restore + confirm green ==="
restore
if "$CHECK" --verify-only >/dev/null 2>&1; then
  note OK restored "clean"
  pass=$((pass + 1))
else
  note BAD restored "did not come back clean"
  "$CHECK" --verify-only | sed 's/^/            /'
  fail=$((fail + 1))
fi

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
