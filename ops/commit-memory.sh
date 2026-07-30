#!/bin/bash
# Commit (and push, when the remote is reachable) any pebbl memory written since
# the last run. Driven by launchd once a day -- see com.ashley.pebbl-memory.
#
# Why this exists: the store is written continuously by every session, but
# nothing is preserved until it is committed. A quiet week would otherwise leave
# a week of decisions on one laptop and nowhere else.
#
# Only events.jsonl is tracked (the rest of .pebbl/ is derived and gitignored),
# so a run either commits one text file or does nothing.
#
# Until 2026-07-30 this lived in dev-tools and committed a store that ~/pebbl
# symlinked into. The store now lives in this repo; the symlink is gone.
set -uo pipefail

REPO="/Users/ashley/pebbl"
PEBBL="/Users/ashley/pebbl/bin/pebbl.js"
LOG="$REPO/.git/memory-commit.log"
PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# launchd hands us a minimal PATH with no node, and node is needed twice: by the
# privacy scan below and by this repo pre-commit hook. Resolve it once and put
# its directory on PATH so both find it. nvm's version dir is globbed rather
# than pinned so a node upgrade does not silently break the job.
if ! command -v node >/dev/null 2>&1; then
  for cand in /opt/homebrew/bin/node /usr/local/bin/node \
              "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$cand" ] && { PATH="$(dirname "$cand"):$PATH"; break; }
  done
fi
if ! command -v node >/dev/null 2>&1; then
  say "FATAL node not found — cannot run the privacy scan, refusing to commit"
  exit 1
fi

# shellcheck source=lib-git-auth.sh
. "$REPO/ops/lib-git-auth.sh"

cd "$REPO" || { say "FATAL cannot cd to $REPO"; exit 1; }

# Never fight a human mid-edit: if anything outside the pebbl stores is dirty,
# this is someone's working session, so stay out of it.
# Capture then trim, rather than piping to `head -1`: head closes the pipe after
# one line and pipefail would turn a DIRTY tree into a non-zero status that reads
# like a git failure.
other_all=$(git status --porcelain -- . ':(exclude).pebbl' || true)
other=$(printf '%s\n' "$other_all" | sed -n '1p')
if [ -n "$other" ]; then
  say "SKIP working tree dirty outside .pebbl ($other)"
  exit 0
fi

# Beat the liveness heartbeat, but ONLY after the run is verified healthy. The
# beat lands in LOOM's store (~/loom), because `loom maintain` reads the registry
# from there every 4h and escalates whatever is OVERDUE — the absence of a beat
# is what turns a silent death into an alarm. Never beat from anywhere but this
# scheduled job: a human beating by hand would mask a dead scheduler.
beat() {
  local proof="$1"
  if ! "$REPO/ops/check-memory-health.sh" >>"$LOG" 2>&1; then
    say "NO BEAT invariants failing — see the health report above; liveness will go OVERDUE"
    return 1
  fi
  # RE-REGISTER before beating, the way loom does for its own recurring jobs.
  # Registration is idempotent (a re-register just refreshes the cadence), and
  # without this the contract is not self-restoring: if loom's store were ever
  # reset, the registration would vanish and `liveness check` would read GREEN
  # off a registry that no longer watches this job — a monitor that silently
  # stops monitoring. Emitter and registry stay together on purpose.
  #
  # Invoke pebbl through node + its entry script, not the bare `pebbl` name:
  # ~/bin is not on launchd's PATH, and a bare name here failed silently in
  # exactly the way this whole heartbeat exists to prevent.
  if (cd /Users/ashley/loom \
        && node "$PEBBL" liveness register pebbl-memory \
             --every 24h --grace 12h >/dev/null 2>&1 \
        && node "$PEBBL" heartbeat pebbl-memory \
             --proof "$proof" >/dev/null 2>&1); then
    say "beat pebbl-memory ($proof)"
  else
    say "WARN heartbeat failed to record — liveness will go OVERDUE even though the run was fine"
  fi
}

if [ -z "$(git status --porcelain -- .pebbl)" ]; then
  # A quiet day is a healthy day: the pipeline ran and there was nothing new, so
  # it must still beat or every quiet stretch would false-alarm.
  say "nothing to commit"
  beat "no new memory"
  exit 0
fi

git add -- .pebbl || { say "FATAL git add failed"; exit 1; }

# The pre-commit hook runs the same scan, but check here too so a block is
# recorded in this log with a readable reason instead of a bare non-zero exit.
# Exit 1 means it found leaks; anything else means the scan itself broke, and a
# scan that cannot run must never be reported as either clean or as a leak.
scan=$(node "$PEBBL" privacy-scan --staged 2>&1)
rc=$?
if [ "$rc" -eq 1 ]; then
  say "BLOCKED privacy-scan found leaks in the staged memory — left staged for review"
  printf '%s\n' "$scan" >> "$LOG"
  exit 1
elif [ "$rc" -ne 0 ]; then
  say "FATAL privacy-scan could not run (exit $rc) — refusing to commit unscanned memory"
  printf '%s\n' "$scan" >> "$LOG"
  exit 1
fi

n=$(git diff --cached --numstat -- .pebbl | awk '{a+=$1; d+=$2} END {print a+0"+/"d+0"-"}')
if git commit -q -m "memory: pebbl decisions through $(date '+%Y-%m-%d') ($n)"; then
  say "committed $n"
else
  say "FATAL commit failed"; exit 1
fi

# The push is what gets memory OFF this machine, so a failure here is a real
# degradation even though the commit is safely local — no beat, so liveness
# escalates it rather than leaving it to be noticed by luck.
pebbl_git_auth "$REPO" push -q origin HEAD 2>>"$LOG"
case $? in
  0) say "pushed"; beat "$(git rev-parse --short HEAD)" ;;
  3) say "push SKIPPED — no token for gh user '$PEBBL_PUSH_GH_USER' (is gh authenticated?); commit is local, NOT beating" ;;
  *) say "push failed (commit is local — token lost repo access); NOT beating" ;;
esac
