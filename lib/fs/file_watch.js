import { spawn } from 'child_process';
import { watch } from 'fs';
import path from 'path';

// --- Config ---
const ENTRY = './index.js';
const WATCH_PATHS = ['./']; // multiple watch roots
const IGNORE_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist/,
  /\.log$/,
  /\.tmp$/,
];
const DEBOUNCE_MS = 150;

let child;
let restartTimer = null;

function isIgnored(filename) {
  if (!filename) return false;
  const normalized = filename.split(path.sep).join('/');
  return IGNORE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function start() {
  child = spawn('node', [ENTRY], { stdio: 'inherit' });
}

function restart() {
  if (child) child.kill();
  start();
}

function scheduleRestart(filename) {
  console.log(`${filename} changed, restarting...`);
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restart, DEBOUNCE_MS);
}

function watchPath(watchPath) {
  watch(watchPath, { recursive: true }, (eventType, filename) => {
    if (isIgnored(filename)) return;
    scheduleRestart(filename);
  });
}

export default function (res, filePath) {
    WATCH_PATHS.forEach(watchPath);
    start();
}