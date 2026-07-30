# Commit Log

## 2026-05-23T18:28:28.926Z - 98e6ef5c: feat: pebbl v0.2 fixes, eval harness, and AGENTS.md protocol refinement
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: EVAL_HARNESS.md,FIXES_V02.md,src/compact.js,src/context.js,src/db.js,src/init.js,src/log-commit.js,src/log.js,src/rubric.js,src/search.js,test/compact.test.js,test/db.test.js,test/migrate.test.js,test/rubric.test.js

## 2026-05-23T18:30:43.712Z - 5e1a8cc7: docs: add comprehensive README for pebbl
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: README.md

## 2026-05-23T23:01:31.594Z - 69251bb0: fix: context orders by tier priority (signal first) then recency, not just recency
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: src/context.js

## 2026-05-24T22:41:23.262Z - 918a89d4: feat: v0.2 — versioned migrations, pebbl upgrade, entry quality guardrails
<!-- cat:data topic: tier:fleeting source:hook -->

Files: AGENTS.md,bin/pebbl.js,package.json,src/context.js,src/db.js,src/detect-thin.js,src/init.js,src/log.js,src/migrate.js,src/rubric.js,src/upgrade.js,test/migrate.test.js

## 2026-05-25T10:53:13.013Z - 8b19f1df: feat: v0.3 — tier hierarchy (foundation/component), narrative system, topic-aware context
<!-- cat:structure topic: tier:fleeting source:hook -->

Files: AGENTS.md,README.md,bin/pebbl.js,package.json,src/args.js,src/compact.js,src/context.js,src/db.js,src/handoff.js,src/init.js,src/log.js,src/migrate.js,src/narrative.js,src/rubric.js,test/args.test.js,test/compact.test.js,test/handoff.test.js,test/migrate.test.js,test/rubric.test.js

## 2026-05-25T10:55:42.973Z - ed5117f9: feat: auto-scope inference, narrative drift detection, component consolidation
<!-- cat:structure topic: tier:fleeting source:hook -->

Files: src/compact.js,src/context.js,src/log.js,src/narrative.js

## 2026-05-25T11:20:00.489Z - f1307a4b: fix: handle legacy integer schema version in migrate.js
<!-- cat:data topic: tier:fleeting source:hook -->

Files: src/migrate.js

## 2026-05-25T11:54:58.492Z - 6c4f7ba0: fix: --scope foundation no longer overridden by rubric tier
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: src/log.js

## 2026-05-25T12:16:00.352Z - ce2fd9df: fix: promote category to decision when foundation pattern matches
<!-- cat:decision topic: tier:fleeting source:hook -->

Files: notes/20260525-135813-piped-note.md,notes/20260525-135817-second-note.md,src/log.js

## 2026-05-25T12:16:11.959Z - 866f0194: fix: promote category to decision when foundation pattern matches
<!-- cat:decision topic: tier:fleeting source:hook -->

Files: src/log.js

## 2026-05-28T22:17:54.407Z - 322a0350: feat: --docs flag on handoffs, new feedback command
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: bin/pebbl.js,notes/20260525-135813-piped-note.md,notes/20260525-135817-second-note.md,notes/agent-harness-engineering-deep-dive.md,notes/design-bitemporal-corrects.md,notes/design-context-pack.md,notes/design-reflect.md,notes/design-rerank.md,src/args.js,src/context.js,src/db.js,src/feedback.js,src/handoff.js,src/migrate.js,test/handoff.test.js

## 2026-05-31T08:40:06.518Z - a8897ff6: feat: keep handoffs structured, materialize at item granularity
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: AGENTS.md,src/context.js,src/handoff.js,src/search.js,test/handoff.test.js,test/search.test.js

## 2026-05-31T08:48:14.048Z - ab67f04f: fix: namespace qmd collection name per project
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: src/qmd.js,test/qmd.test.js

## 2026-06-02T14:26:31.746Z - 58efb6fb: chore: delete superseded v0.2 implementation planning docs
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: FIXES_V02.md,IMPLEMENT_V02.md

## 2026-06-02T14:26:42.248Z - ed0163d1: fix: v0.4 migration guards against missing handoffs table
<!-- cat:data topic: tier:fleeting source:hook -->

Files: src/migrate.js,test/migrate.test.js

## 2026-06-02T14:26:49.979Z - 95f5ebb9: feat: sentinel-delimited pebbl block in AGENTS.md
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: src/eject.js,src/init.js,src/upgrade.js

## 2026-06-02T14:26:55.813Z - 5d5f2f05: feat: add help system with --help flag and pebbl help subcommand
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: bin/pebbl.js,src/help.js

## 2026-06-02T14:27:02.193Z - d288a54a: feat: warn when log entry stored as uncategorized
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: src/log.js

## 2026-06-02T14:27:07.969Z - 32ac0588: fix: clarify handoff display labels in context output
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: src/context.js

## 2026-06-02T14:27:13.900Z - f0a1b618: docs: rewrite AGENTS.md as concise developer reference
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: AGENTS.md

## 2026-06-02T14:27:19.510Z - f9b883e2: test: add init/upgrade/eject integration tests
<!-- cat:integration topic: tier:fleeting source:hook -->

Files: test/init-upgrade-eject.test.js

## 2026-06-10T03:05:11.660Z - f29b1491: feat: add success trace convention — rubric rule, migration, and AGENTS.md docs
<!-- cat:pattern topic: tier:fleeting source:hook -->

Files: AGENTS.md,src/rubric.js,test/migrate.test.js,test/rubric.test.js

## 2026-06-11T00:15:04.361Z - 24ead61b: docs: track source PEBBL.md in repo root
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: .gitignore,PEBBL.md

## 2026-06-11T01:05:10.625Z - 85eb5fcf: docs: route interactive sessions through the factory queue
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: AGENTS.md

## 2026-07-02T15:52:31.104Z - 1faa9819: docs: replace stale sw-factory routing with loom routing
<!-- cat:uncategorized topic: tier:fleeting source:hook -->

Files: AGENTS.md

