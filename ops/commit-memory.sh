#!/bin/bash
# Commit (and push) any pebbl memory written since the last run, for EVERY store
# listed in stores.json. Driven by launchd once a day -- see com.ashley.pebbl-memory.
#
# Why this exists: a store is written continuously by every session, but nothing
# is preserved until it is committed and nothing leaves the machine until it is
# pushed. A quiet week would otherwise leave a week of decisions on one laptop.
# The trigger for building it: 16 entries -- a full day of decisions -- were found
# sitting uncommitted, and loom's store had never left this disk at all.
#
# ONE job over a LIST, not one job per repo. Six near-identical committers is how
# five of them quietly drift. Adding a store is a line in stores.json.
#
# Only events.jsonl (plus the audit ledger and the few real store files each repo
# tracks) is versioned; the rest of .pebbl/ is derived and gitignored, so a run
# either commits a little text or does nothing.
#
# EVERY STORE BEATS ITS OWN HEARTBEAT. A single shared beat would read green as
# long as ANY store committed, which hides precisely the failure worth catching:
# one repo silently dropping out while the others carry the signal.
#
# Until 2026-07-30 this lived in dev-tools and committed a single store that
# ~/pebbl symlinked into. The store moved into this repo; the symlink is gone.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PEBBL="/Users/ashley/pebbl/bin/pebbl.js"
STORES="$HERE/stores.json"
LOG="/Users/ashley/pebbl/.git/memory-commit.log"
LOOM_STORE="/Users/ashley/loom"
PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# shellcheck source=lib-git-auth.sh
. "$HERE/lib-git-auth.sh"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# launchd hands us a minimal PATH with no node, and node is needed three times
# over: the privacy scan, the store list, and pebbl itself. Resolve it once.
# nvm's version dir is globbed rather than pinned so a node upgrade does not
# silently break the job.
if ! command -v node >/dev/null 2>&1; then
  for cand in /opt/homebrew/bin/node /usr/local/bin/node \
              "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$cand" ] && { PATH="$(dirname "$cand"):$PATH"; break; }
  done
fi
if ! command -v node >/dev/null 2>&1; then
  say "FATAL node not found — cannot run the privacy scan, refusing to commit anything"
  exit 1
fi

# Beat a store's liveness, but ONLY after its run is verified. The beat lands in
# LOOM's store, because `loom maintain` reads that registry every 4h and
# escalates whatever is OVERDUE -- the absence of a beat is what turns a silent
# death into an alarm. Never beat from anywhere but this scheduled job: a human
# beating by hand would mask a dead scheduler.
#
# RE-REGISTER before beating, the way loom does for its own recurring jobs.
# Registration is idempotent, and without it the contract is not self-restoring:
# if loom's store were reset, the registration would vanish and `liveness check`
# would read GREEN off a registry that no longer watches this job -- a monitor
# that has silently stopped monitoring.
beat() {
  local job="$1" proof="$2"
  if (cd "$LOOM_STORE" \
        && node "$PEBBL" liveness register "$job" --every 24h --grace 12h >/dev/null 2>&1 \
        && node "$PEBBL" heartbeat "$job" --proof "$proof" >/dev/null 2>&1); then
    say "  beat $job ($proof)"
  else
    say "  WARN heartbeat failed for $job — liveness will go OVERDUE even though the run was fine"
  fi
}

# Commit + push one store. Returns 0 when the store is healthy (committed and
# pushed, or genuinely had nothing to do), non-zero otherwise. A store that fails
# must NOT stop the others: one broken repo silencing every other store's backup
# is the exact failure this loop exists to avoid.
commit_store() {
  local name="$1" path="$2" push_user="$3"
  local job="memory-$name"
  say "[$name] $path"

  if [ ! -d "$path/.pebbl" ]; then
    say "  FAIL no .pebbl/ at $path"
    return 1
  fi
  if ! git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    say "  FAIL $path is not a git worktree"
    return 1
  fi

  # Never hijack a human's in-progress commit. The precise hazard is the INDEX:
  # we only ever `git add` the store paths, but `git commit` sweeps up whatever
  # is ALREADY staged. Untracked files and unstaged edits are not that hazard and
  # must not block -- loom's tree is essentially never clean, and a "skip if
  # anything is dirty" rule would mean loom's memory is never committed at all:
  # a silent backup failure dressed up as politeness.
  local staged
  staged=$(git -C "$path" diff --cached --name-only -- . ':(exclude).pebbl' ':(exclude).pebbl-audit-accepted.json' 2>/dev/null | sed -n '1p')
  if [ -n "$staged" ]; then
    say "  SKIP something is already staged outside the store ($staged) — not committing over it"
    return 1
  fi

  git -C "$path" add -- .pebbl .pebbl-audit-accepted.json >/dev/null 2>&1

  local pending
  pending=$(git -C "$path" diff --cached --name-only 2>/dev/null | sed -n '1p')
  if [ -n "$pending" ]; then
    # The pre-commit hook runs the same scan, but check here too so a block is
    # recorded in this log with a readable reason instead of a bare non-zero
    # exit. Exit 1 means it found leaks; anything else means the scan itself
    # broke, and a scan that cannot run must never be reported as clean.
    local scan rc
    scan=$( (cd "$path" && node "$PEBBL" privacy-scan --staged 2>&1) )
    rc=$?
    if [ "$rc" -eq 1 ]; then
      say "  BLOCKED privacy-scan found leaks — left staged for review"
      printf '%s\n' "$scan" >> "$LOG"
      return 1
    elif [ "$rc" -ne 0 ]; then
      say "  FATAL privacy-scan could not run (exit $rc) — refusing to commit unscanned memory"
      printf '%s\n' "$scan" >> "$LOG"
      return 1
    fi
    local n
    n=$(git -C "$path" diff --cached --numstat | awk '{a+=$1; d+=$2} END {print a+0"+/"d+0"-"}')
    # Capture the commit's own output. A repo can have a heavyweight pre-commit
    # gate (loom runs fmt + lint + its whole test suite), and when one of those
    # fails the reason is the only thing that makes the failure actionable.
    # Discarding it left "FATAL commit failed" with no cause — the precise shape
    # of silent failure this pipeline exists to eliminate, reproduced inside the
    # pipeline itself.
    local cout
    cout=$( { git -C "$path" commit -q -m "memory: $name decisions through $(date '+%Y-%m-%d') ($n)"; } 2>&1 )
    if [ $? -eq 0 ]; then
      say "  committed $n"
    else
      say "  FATAL commit failed — output follows"
      printf '%s\n' "$cout" | tail -40 >> "$LOG"
      return 1
    fi
  else
    say "  nothing new to commit"
  fi

  # A store with no remote can be versioned but not backed up. Say so, and do NOT
  # beat: a green heartbeat for memory that never left the laptop is exactly the
  # lie the heartbeat exists to prevent.
  if ! git -C "$path" remote get-url origin >/dev/null 2>&1; then
    say "  NO REMOTE — committed locally only, nothing left this machine; NOT beating"
    return 1
  fi

  local ahead
  ahead=$(git -C "$path" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo unknown)
  if [ "$ahead" = "0" ]; then
    # A quiet day is a healthy day: the pipeline ran, there was nothing new, and
    # the remote already has everything. It must still beat, or every quiet
    # stretch would false-alarm.
    beat "$job" "up to date, nothing new"
    return 0
  fi
  # No upstream is the NORMAL state for a working branch, not an error. loom
  # spends its life on a feature branch, and refusing to push there would leave
  # its memory permanently unbacked-up while the log said only "cannot tell" --
  # a backup that quietly never runs. This is a backup remote, so the right move
  # is to create the matching remote branch and track it.
  local pushargs=(push -q origin HEAD)
  if [ "$ahead" = "unknown" ]; then
    local branch
    branch=$(git -C "$path" rev-parse --abbrev-ref HEAD)
    say "  no upstream for $branch — pushing it to origin and setting tracking"
    pushargs=(push -q -u origin "HEAD:$branch")
    ahead="new-branch"
  fi

  PEBBL_PUSH_GH_USER="${push_user:-$PEBBL_PUSH_GH_USER}" pebbl_git_auth "$path" "${pushargs[@]}" 2>>"$LOG"
  case $? in
    0)
      say "  pushed ($ahead commits)"
      beat "$job" "$(git -C "$path" rev-parse --short HEAD)"
      return 0
      ;;
    3)
      say "  push SKIPPED — no token for gh user '${push_user:-<active>}'; commit is local, NOT beating"
      return 1
      ;;
    *)
      say "  push FAILED — commit is local, NOT beating"
      return 1
      ;;
  esac
}

if [ ! -f "$STORES" ]; then
  say "FATAL no store list at $STORES"
  exit 1
fi

# One tab-separated record per store. A malformed or empty list is FATAL rather
# than an empty loop: silently committing zero stores looks identical to a clean
# run, and would be the quietest possible way for every backup to stop.
rows=$(node -e '
  const fs = require("fs");
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
  catch (e) { console.error("unparseable store list: " + e.message); process.exit(1); }
  const list = Array.isArray(cfg.stores) ? cfg.stores : null;
  if (!list || list.length === 0) { console.error("store list has no stores[] entries"); process.exit(1); }
  for (const s of list) {
    if (!s || !s.name || !s.path) { console.error("a store entry is missing name or path"); process.exit(1); }
    process.stdout.write([s.name, s.path, s.pushUser || ""].join("\t") + "\n");
  }
' "$STORES" 2>>"$LOG")
if [ -z "$rows" ]; then
  say "FATAL store list is empty or malformed — refusing to run (reason logged above)"
  exit 1
fi

say "=== run start ($(printf '%s\n' "$rows" | wc -l | tr -d ' ') store(s)) ==="
failed=0
while IFS=$'\t' read -r name path push_user; do
  [ -n "$name" ] || continue
  commit_store "$name" "$path" "$push_user" || failed=$((failed + 1))
done <<< "$rows"

if [ "$failed" -gt 0 ]; then
  say "=== run end: $failed store(s) did not complete ==="
  exit 1
fi
say "=== run end: all stores healthy ==="
