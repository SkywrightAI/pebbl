#!/bin/bash
# Verify — and REPAIR — every invariant the pebbl-memory pipeline depends on.
#
# Repairing by default is a deliberate choice: these invariants have exactly one
# correct state (the symlink points at one place, the agent is either loaded or
# not), so there is no diagnosis to get wrong. Two carve-outs where that is NOT
# true are report-only and named as such below.
#
# The guard against auto-repair hiding a real problem: every repair is LOGGED to
# pebbl. pebbl's recurrence detector then counts repeats, and `loom maintain`
# escalates anything over threshold — so a thing that keeps breaking becomes an
# escalation instead of a silently re-applied band-aid.
#
#   (no args)   verify and repair          --verify-only   report, change nothing
#   --json      machine-readable           --fix-location  allow the repo relocation
#
# Exit 0 = everything holds (possibly after repair). Exit 1 = something is still
# broken and needs a human.
set -uo pipefail

REPO="/Users/ashley/pebbl"
PEBBL="/Users/ashley/pebbl/bin/pebbl.js"
LIVE="$REPO/.pebbl"
STORE_LINK="/Users/ashley/pebbl/.pebbl"
LABEL="com.ashley.pebbl-memory"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNPUSHED_MAX=3
UNCOMMITTED_MAX_H=36

# shellcheck source=lib-git-auth.sh
. "/Users/ashley/pebbl/ops/lib-git-auth.sh"

JSON=0; REPAIR=1; FIX_LOCATION=0
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    --verify-only) REPAIR=0 ;;
    --fix-location) FIX_LOCATION=1 ;;
  esac
done

fails=0; repairs=0
findings=()

ok()     { findings+=("PASS|$1|$2"); }
fail()   { findings+=("FAIL|$1|$2"); fails=$((fails + 1)); }
fixed()  { findings+=("FIXED|$1|$2"); repairs=$((repairs + 1)); log_repair "$1" "$2"; }

# Record the repair in pebbl so a RECURRING break escalates instead of being
# quietly papered over every night. Best-effort: a store that cannot be written
# must not turn a successful repair into a failure.
log_repair() {
  local check="$1" detail="$2"
  (cd /Users/ashley/loom && node "$PEBBL" log \
     "auto-repaired dev-tools memory invariant [$check]: $detail" \
     --cat steering --topic loom,pebbl,liveness,self-heal >/dev/null 2>&1) || true
}

# Attempt a repair only when repairing is enabled; otherwise record the FAIL.
# $1 check name, $2 problem description, $3 repair description, $4.. the command.
try_fix() {
  local check="$1" problem="$2" what="$3"; shift 3
  if [ "$REPAIR" != "1" ]; then
    fail "$check" "$problem (repairable: $what)"
    return 1
  fi
  if "$@" >/dev/null 2>&1; then
    fixed "$check" "$problem -> $what"
    return 0
  fi
  fail "$check" "$problem — REPAIR FAILED ($what)"
  return 1
}

# ── 1. the store lives IN the repo ───────────────────────────────────────────
# This used to assert the opposite: ~/pebbl/.pebbl was a SYMLINK into
# dev-tools/pebbl-history/live, and the check repaired anything that wasn't.
# The store moved into this repo on 2026-07-30, so that invariant is inverted --
# a symlink here now means memory is being written OUTSIDE the repo, unversioned
# and unbacked-up, which is exactly the failure the move was meant to end.
#
# Deliberately NOT auto-repaired. A symlink appearing here means a store exists
# somewhere else with history in it, and silently replacing the link would strand
# that history where nothing looks for it. Report loudly, let a human merge.
check_store_inrepo() {
  if [ -L "$STORE_LINK" ]; then
    fail store-inrepo "\$STORE_LINK is a SYMLINK to $(readlink "$STORE_LINK") -- memory is being written outside the repo, unversioned. Do NOT delete it; merge that store back into $LIVE first."
    return
  fi
  if [ ! -d "$STORE_LINK" ]; then
    fail store-inrepo "\$STORE_LINK is missing entirely -- the store is gone; restore it from git before anything writes a new one"
    return
  fi
  if [ ! -f "$LIVE/events.jsonl" ]; then
    fail store-inrepo "$LIVE exists but events.jsonl is missing -- do NOT guess at this, the canonical log is gone"
    return
  fi
  if ! git -C "$REPO" ls-files --error-unmatch .pebbl/events.jsonl >/dev/null 2>&1; then
    fail store-inrepo "events.jsonl exists but is NOT tracked by git -- memory is local-only and one disk failure from gone"
    return
  fi
  ok store-inrepo "store is a real directory in the repo and events.jsonl is tracked"
}

# ── 2. the store actually serves its own memory ──────────────────────────────
# The worst failure found so far, because it looks like nothing: pebbl decides
# per-store whether events.jsonl or db.sqlite is canonical. Reaching the
# git-based fallback here means it sees .pebbl/ gitignored in ~/pebbl and serves
# db.sqlite — which this store does not keep — so every read returns an EMPTY
# store while the real history sits right there in events.jsonl. No error, no
# warning, just amnesia. The `.events-canonical` marker pins it to the fold.
#
# The repair only writes the marker when the fold PROVES completeness (folded
# entry count == append-event count). Asserting completeness we have not verified
# would be the one repair here that could actually lose history.
check_store_mode() {
  local mode entries appends
  mode=$(node -e "console.log(require('/Users/ashley/pebbl/src/store-mode').storeMode('$STORE_LINK'))" 2>/dev/null)
  if [ "$mode" = "events" ]; then
    ok store-mode "events.jsonl is canonical; reads served from the fold"
    return
  fi
  appends=$(grep -c '"type":"append"' "$LIVE/events.jsonl" 2>/dev/null || echo 0)
  entries=$(sqlite3 "$LIVE/view.sqlite" "SELECT COUNT(*) FROM logs;" 2>/dev/null || echo -1)
  if [ "$REPAIR" != "1" ]; then
    fail store-mode "mode is '$mode' — reads are served from db.sqlite, which this store does not keep, so pebbl returns an EMPTY store"
    return
  fi
  if [ "$appends" -gt 0 ] && [ "$entries" = "$appends" ]; then
    if printf 'events.jsonl is the complete, canonical representation of this store.\n' \
         > "$LIVE/.events-canonical" 2>/dev/null; then
      fixed store-mode "mode was '$mode' (reads came back EMPTY) -> wrote .events-canonical after verifying $entries folded entries == $appends append events"
    else
      fail store-mode "mode is '$mode' and the marker could not be written"
    fi
  else
    fail store-mode "mode is '$mode' and completeness is UNPROVEN (fold=$entries, appends=$appends) — do not mark it canonical, recover db.sqlite or re-fold first"
  fi
}

# ── 3. repo location (TCC) — REPORT-ONLY by default ──────────────────────────
# Relocating means moving 37 files and repointing 10 symlinks. Doing that
# underneath a live session is how you corrupt someone's work in progress, so it
# needs --fix-location. This is one of the two carve-outs.
check_repo_location() {
  case "$REPO" in
    "$HOME"/Documents/*|"$HOME"/Desktop/*|"$HOME"/Downloads/*) ;;
    *) ok repo-location "$REPO is outside the TCC-protected folders"; return ;;
  esac
  if [ "$FIX_LOCATION" = "1" ] && [ "$REPAIR" = "1" ]; then
    fail repo-location "inside a TCC-protected folder — rerun the move by hand: mv '$REPO' ~/dev-tools then re-run this check to repair the symlinks"
  else
    fail repo-location "inside a macOS TCC-protected folder — launchd cannot read it (pass --fix-location for guidance; not moved automatically under a live session)"
  fi
}

# ── 3. the scheduled job is loaded ───────────────────────────────────────────
check_launchd() {
  # No pipe at all: any `producer | grep -q` hands the producer SIGPIPE when
  # grep exits on the first match, which `set -o pipefail` then reports as a
  # failed pipeline -- so a LOADED job intermittently reads as unloaded. A
  # case-glob match reads the same and cannot short-circuit anything.
  case "$(launchctl list 2>/dev/null || true)" in
    *"$LABEL"*)
      ok launchd "$LABEL is loaded"
      return
      ;;
  esac
  if [ ! -f "$PLIST" ]; then
    fail launchd "$LABEL not loaded and its plist is missing at $PLIST"
    return
  fi
  try_fix launchd "$LABEL was not loaded" "launchctl load $PLIST" \
    launchctl load "$PLIST"
}

# ── 5. only canonical files tracked for the live store ───────────────────────
check_tracked_set() {
  local derived
  derived=$(git -C "$REPO" ls-files .pebbl \
    | grep -Ev '^.pebbl/(events\.jsonl|rubric\.yml|config\.yml|\.events-canonical)$' || true)
  if [ -z "$derived" ]; then
    ok tracked-set "live store tracks only events.jsonl + rubric + config"
    return
  fi
  # Untrack, never delete: the working copies stay, they just stop being
  # versioned. Derived files regenerate with `pebbl rebuild` regardless.
  if [ "$REPAIR" != "1" ]; then
    fail tracked-set "derived files tracked: $(echo "$derived" | tr '\n' ' ')"
    return
  fi
  if echo "$derived" | xargs git -C "$REPO" rm -q --cached >/dev/null 2>&1; then
    fixed tracked-set "untracked derived files (kept on disk): $(echo "$derived" | tr '\n' ' ')"
  else
    fail tracked-set "could not untrack: $(echo "$derived" | tr '\n' ' ')"
  fi
}

# ── 6. push auth — REPORT-ONLY, nothing local can fix it ─────────────────────
# The second carve-out: an expired or unscoped PAT lives in GitHub's settings.
# No local action repairs it, and pretending otherwise would be theatre.
check_push_auth() {
  if ! git -C "$REPO" remote get-url origin >/dev/null 2>&1; then
    fail push-auth "no origin remote configured — git remote add origin <url>"
  elif pebbl_git_auth "$REPO" push --dry-run origin HEAD >/dev/null 2>&1; then
    ok push-auth "origin accepts a write as gh user '$PEBBL_PUSH_GH_USER'"
  else
    fail push-auth "origin REFUSED a dry-run push as gh user '$PEBBL_PUSH_GH_USER' — token expired or lost repo access; fix it in GitHub token settings (nothing local can repair this)"
  fi
}

# ── 7. unpushed drift ────────────────────────────────────────────────────────
check_unpushed() {
  if ! git -C "$REPO" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
    try_fix unpushed "no upstream set" "tracking origin/main" \
      git -C "$REPO" branch --set-upstream-to=origin/main
    return
  fi
  local ahead; ahead=$(git -C "$REPO" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)
  if [ "$ahead" -le "$UNPUSHED_MAX" ]; then
    ok unpushed "$ahead commit(s) ahead of origin"
    return
  fi
  try_fix unpushed "$ahead commits unpushed" "pushed to origin" \
    pebbl_git_auth "$REPO" push -q origin HEAD
}

# ── 8. uncommitted memory is not stuck ───────────────────────────────────────
check_uncommitted() {
  if [ -z "$(git -C "$REPO" status --porcelain -- .pebbl 2>/dev/null)" ]; then
    ok uncommitted "no uncommitted memory"
    return
  fi
  local mtime age_h
  mtime=$(stat -f %m "$LIVE/events.jsonl" 2>/dev/null || echo 0)
  age_h=$(( ( $(date +%s) - mtime ) / 3600 ))
  if [ "$age_h" -le "$UNCOMMITTED_MAX_H" ]; then
    ok uncommitted "memory dirty but fresh (${age_h}h)"
    return
  fi
  if [ "$REPAIR" != "1" ]; then
    fail uncommitted "memory uncommitted for ${age_h}h — the committer is stuck"
    return
  fi
  # Commit ONLY pebbl-history, and only after the privacy scan passes. Whatever
  # else is dirty stays untouched — that is someone's work, not ours to commit.
  if ! git -C "$REPO" add -- .pebbl >/dev/null 2>&1; then
    fail uncommitted "stuck ${age_h}h and could not stage pebbl-history"; return
  fi
  if ! node "$PEBBL" privacy-scan --staged >/dev/null 2>&1; then
    fail uncommitted "stuck ${age_h}h and the privacy scan refuses the staged memory — needs a human"
    return
  fi
  if git -C "$REPO" commit -q -m "memory: unstick $(date '+%Y-%m-%d') (auto-repair)" >/dev/null 2>&1; then
    fixed uncommitted "memory was uncommitted for ${age_h}h -> committed (pebbl-history only)"
  else
    fail uncommitted "stuck ${age_h}h and the commit failed"
  fi
}

check_store_inrepo
check_store_mode
check_repo_location
check_launchd
check_tracked_set
check_push_auth
check_unpushed
check_uncommitted

# ── report ───────────────────────────────────────────────────────────────────
if [ "$JSON" = "1" ]; then
  printf '{"ok":%s,"fails":%d,"repairs":%d,"findings":[' \
    "$([ "$fails" -eq 0 ] && echo true || echo false)" "$fails" "$repairs"
  first=1
  for f in "${findings[@]}"; do
    IFS='|' read -r status name detail <<< "$f"
    [ "$first" = 1 ] || printf ','
    first=0
    printf '{"status":"%s","check":"%s","detail":"%s"}' "$status" "$name" "${detail//\"/\\\"}"
  done
  printf ']}\n'
else
  echo "--- pebbl memory health ---"
  for f in "${findings[@]}"; do
    IFS='|' read -r status name detail <<< "$f"
    printf '%-5s %-15s %s\n' "$status" "$name" "$detail"
  done
  summary="${#findings[@]} invariants"
  [ "$repairs" -gt 0 ] && summary="$summary, $repairs repaired"
  if [ "$fails" -eq 0 ]; then
    echo "--- all hold ($summary) ---"
  else
    echo "--- $fails STILL BROKEN ($summary) ---"
  fi
fi

[ "$fails" -eq 0 ] || exit 1
