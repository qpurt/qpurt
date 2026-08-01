import fs from 'node:fs';

export default function file_exists(p) {
  return new Promise((resolve) => {
    fs.access(p, fs.constants.F_OK, (err) => resolve(!err));
  });
};