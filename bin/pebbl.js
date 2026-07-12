#!/usr/bin/env node
'use strict';

const help = require('../src/help');

const [,, command, ...args] = process.argv;

const wantsHelp = (a) => a.includes('--help') || a.includes('-h');

const commands = {
  init:         () => require('../src/init')(args),
  log:          () => require('../src/log')(args),
  search:       () => require('../src/search')(args),
  readback:     () => require('../src/readback')(args),
  liveness:     () => require('../src/liveness').liveness(args),
  heartbeat:    () => require('../src/liveness').heartbeat(args),
  recurrence:   () => require('../src/encode')(args),
  context:      () => require('../src/context')(args),
  compact:      () => require('../src/compact')(args),
  rebuild:      () => require('../src/rebuild')(args),
  upgrade:      () => require('../src/upgrade')(),
  eject:        () => require('../src/eject')(),
  handoff:      () => require('../src/handoff')(args),
  narrative:    () => require('../src/narrative')(args),
  feedback:     () => require('../src/feedback')(args),
  check:        () => require('../src/check')(args),
  doctor:       () => require('../src/doctor')(args),
  'scan-commits': () => require('../src/scan-commits')(args),
  'audit-history': () => require('../src/audit-history')(args),
  'privacy-scan': () => require('../src/privacy-scan').cli(args),
  'log-commit': () => require('../src/log-commit')(args[0], args[1], args[2]),
  'migrate-to-events': () => require('../src/migrate-to-events')(args),
  'repair-rollups': () => require('../src/repair-rollups')(args),
  cutover:      () => require('../src/cutover')(args),
};

// P6: `cutover` owns its own --help (the runbook lives once in src/cutover.js,
// DRY), so it must NOT be intercepted by the generic help table below.
const ownsHelp = new Set(['cutover']);

if (!command || command === '--help' || command === '-h') {
  help.printToplevel();
  process.exit(0);
}

if (command === 'help') {
  if (!args[0]) { help.printToplevel(); process.exit(0); }
  if (args[0] in commands) { help.printSubcommand(args[0]); process.exit(0); }
  help.printTopic(args[0]);
  process.exit(0);
}

if (wantsHelp(args) && !ownsHelp.has(command)) {
  if (command in commands) { help.printSubcommand(command); process.exit(0); }
  help.printToplevel();
  process.exit(0);
}

if (!(command in commands)) {
  console.error(`pebbl: unknown command '${command}'\n`);
  help.printToplevel();
  process.exit(1);
}

commands[command]();
