import { spawn } from 'child_process';
import { watch } from 'fs';

let child;

function start() {
  child = spawn('node', ['../index.js'], { stdio: 'inherit' });
}

function restart() {
  if (child) child.kill();
  start();
}

watch('../', { recursive: true }, (eventType, filename) => {
  console.log(`${filename} changed, restarting...`);
  restart();
});

start();