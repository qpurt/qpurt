#!/usr/bin/env node

import BUILD from "./cmd/build.js";
import HELP from "./cmd/help.js";
import PUBLISH from "./cmd/publish.js";
import START from "./cmd/start.js";
import UPDATE from "./cmd/update.js";

const args = process.argv.slice(2);

const parsed = {};
const positional = [];

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

positional.forEach(cmd => {
    switch (cmd) {
        case 'build': BUILD(positional, parsed); break;
        case 'help': HELP(positional, parsed); break;
        case 'publish': PUBLISH(positional, parsed); break;
        case 'start': START(positional, parsed); break;
        case 'update': UPDATE(positional, parsed); break;
        default: console.log('unknown command: ' + cmd);
    }
});