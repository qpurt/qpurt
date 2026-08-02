#!/usr/bin/env node
// QPURT CLI

// Imports
import BUILD from "./cmd/build.js";
import CREATE from "./cmd/create.js";
import HELP from "./cmd/help.js";
import PUBLISH from "./cmd/publish.js";
import START from "./cmd/start.js";
import UPDATE from "./cmd/update.js";

// Variables
const args = process.argv.slice(2);
const parsed = {};
const positional = [];

const commands = {
    build: BUILD,
    create: CREATE,
    help: HELP,
    publish: PUBLISH,
    start: START,
    update: UPDATE,
};

// Parser
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=');
    parsed[key] = value ?? true; // --flag with no value => true
  } else if (arg.startsWith('-')) {
    parsed[arg.slice(1)] = true;
  } else {
    positional.push(arg);
  }
}

// Run help on no args.
if (args.length === 0) HELP();

// Commands
positional.forEach(cmd => {
    const handler = commands[cmd];
    if (handler) handler(positional, parsed);
    else console.log('unknown command: ' + cmd);
});