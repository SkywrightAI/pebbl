# ops — keeping pebbl's own memory alive

pebbl uses itself. Its store is `../.pebbl/`, and these three scripts are what
stop that store from existing only on one laptop.

| Script | What it does |
|---|---|
| `commit-memory.sh` | Commits and pushes new memory once a day (launchd `com.ashley.pebbl-memory`, 22:00). Runs the privacy scan first and refuses to commit unscanned memory if the scan cannot run. Log: `.git/memory-commit.log`. |
| `check-memory-health.sh` | Verifies — and repairs — the eight invariants the pipeline depends on. |
| `test-memory-health.sh` | Breaks each invariant on purpose and asserts the check catches it. |
| `lib-git-auth.sh` | Resolves the gh account that can actually push to this org repo. |

```sh
cd ~/pebbl
bash ops/check-memory-health.sh     # what is broken, right now
bash ops/test-memory-health.sh      # prove the checks still catch faults
bash ops/commit-memory.sh           # run the daily job by hand
cd ~/loom && pebbl liveness check   # is the beat current?
```

## Why any of this exists

Every way this pipeline breaks is quiet. Nothing throws when a launchd job stops
firing, when a token expires, or when a second store appears outside the repo.
You just stop having history and find out months later.

You cannot watch for an absence, so it is flipped into a presence: **the job
beats a liveness heartbeat, and only after the invariant checks pass.**
`loom maintain` walks that registry every four hours and escalates whatever is
OVERDUE. No beat for 24h + 12h grace and it gets raised.

| Silent failure | Caught by |
|---|---|
| launchd job unloaded or never fires | no heartbeat → OVERDUE |
| committer stuck skipping a dirty tree | no heartbeat, and the `uncommitted` age probe |
| token expired, pushes failing | `push-auth` dry-run probe, and no heartbeat |
| a second store appears outside the repo | `store-inrepo` probe |
| gitignore regressed, derived files tracked | `tracked-set` probe |
| repo moved under `~/Documents` (TCC) | `repo-location` probe |
| commits piling up unpushed | `unpushed` drift probe |
| store silently reads EMPTY (amnesia) | `store-mode` probe |

Three properties that matter more than the list:

**The check repairs, and every repair is logged.** These invariants have exactly
one correct state, so there is no diagnosis to get wrong. The guard against a
band-aid: each repair writes to pebbl, so recurrence counts repeats and `loom
maintain` escalates a thing that keeps breaking instead of letting it be
re-fixed silently every night. Three things stay report-only and say so —
relocating the repo, an expired token that only GitHub settings can fix, and a
store that reappears outside the repo (relinking would strand whatever history
the other store holds).

**Only the scheduled job may beat.** If running the check by hand could beat,
then a human looking into things would mask a dead scheduler — hiding the exact
failure being hunted.

**The heartbeat re-registers its own contract every run.** Otherwise a reset of
loom's store would drop the registration and the check would read green for a
job it had quietly stopped watching.

`test-memory-health.sh` exists for the same reason: a monitor that has only ever
returned green is indistinguishable from one that cannot fail.

## History

This lived in `dev-tools/bin` until 2026-07-30, watching a store in
`dev-tools/pebbl-history/live` that `~/pebbl/.pebbl` symlinked into. The store
moved here so the tool and its memory travel together, and the scripts moved
with it. Two invariants changed shape in the move:

- `store-symlink` became `store-inrepo`, and inverted. A symlink at `.pebbl` used
  to be the correct state; now it means memory is being written outside the repo.
- The amnesia failure can no longer be induced on the live store at all.
  `storeMode` asks git whether `events.jsonl` is ignored, and `git check-ignore`
  does not report tracked paths — so once the log is tracked, no gitignore
  regression can push reads back onto the `db.sqlite` this store does not keep.
  The completeness marker is now belt-and-braces rather than the only guard.
