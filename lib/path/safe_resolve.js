import path from 'node:path';
import __dirname from './__dirname.js';

const publicDir = path.join(__dirname(), 'public');
const publicDirResolved = path.resolve(publicDir);

export default function safe_resolve(...segments) {
  const resolved = path.resolve(publicDir, ...segments);
  if (resolved !== publicDirResolved && !resolved.startsWith(publicDirResolved + path.sep)) {
    return null;
  }
  return resolved;
};