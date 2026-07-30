#!/bin/bash
# Shared git-push credentials for the scheduled memory jobs.
#
# Why this exists: this repo lives under the SkywrightAI org, and the gh account
# that is active by default (AshleyxAdamson) holds a fine-grained PAT whose
# Resource owner is the personal account, not the org. It can READ the public
# repo and reports admin permissions, but every push returns 403, and every
# private org repo returns 404 rather than 403 -- GitHub hides what a token has
# no grant on, which is what makes this fail look like a missing repo instead of
# a missing permission.
#
# The scheduled job MUST NOT inherit that ambiguity. A backup that commits
# locally and silently fails to push is not a backup, and it is the exact shape
# of failure the heartbeat exists to catch: the commit succeeds, the push does
# not, and nothing off this laptop changes.
#
# So the push account is named explicitly rather than inherited. No token is
# stored on disk -- it is resolved from gh's keyring at run time, so rotating the
# token in gh is the whole rotation. Override with PEBBL_PUSH_GH_USER when the
# account changes (e.g. once a properly org-scoped PAT exists on the primary
# account, set it to that and this file needs no edit).

PEBBL_PUSH_GH_USER="${PEBBL_PUSH_GH_USER:-newpathai}"

# launchd hands the job a minimal PATH with no gh, exactly as it does for node.
# Resolve it once so the token lookup does not fail silently and get reported as
# a credentials problem it is not.
pebbl_find_gh() {
  if command -v gh >/dev/null 2>&1; then command -v gh; return 0; fi
  for cand in /opt/homebrew/bin/gh /usr/local/bin/gh; do
    [ -x "$cand" ] && { printf '%s\n' "$cand"; return 0; }
  done
  return 1
}

# Echo a token for the push account, or nothing if it cannot be resolved.
# Callers must treat empty as "cannot push" rather than falling through to the
# ambient credential helper -- falling through is what produces the 403.
pebbl_git_token() {
  local gh; gh=$(pebbl_find_gh) || return 1
  "$gh" auth token --user "$PEBBL_PUSH_GH_USER" 2>/dev/null
}

# Run a git command in $1 with the push account's credentials.
# Usage: pebbl_git_push "$REPO" push -q origin HEAD
pebbl_git_auth() {
  local repo="$1"; shift
  local tok; tok=$(pebbl_git_token)
  if [ -z "$tok" ]; then return 3; fi   # 3 = no credentials, distinct from a git failure
  GH_TOKEN="$tok" git -C "$repo" "$@"
}
