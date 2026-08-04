// QPURT API

// Node module imports
import fs from 'node:fs';
import path from 'node:path';

// Config Imports
import dc from './lib/config/qpd_server.js';
import pkg from "./package.json" with { type: 'json' };

// New file exists function
function file_exists(filepath, mode = fs.constants.F_OK) {
  try {
    fs.accessSync(filepath, mode);
    return true;
  } catch {
    return false;
  }
}

// Dynamic Vars
let pkgc, filec, objc, config;

// qpurt.server()
export function server(c=dc) {

  // Check if package.json has qpConfig.server
  if (pkg.qpConfig && pkg.qpConfig.server) pkgc = pkg.qpConfig.server;

  // Check if file config provided to arg1
  if (typeof c === 'string') {
    if (!file_exists(path.resolve(c))) { 
      console.log(`error: ${path.resolve(c)} does not exist..`); 
      process.exit();
    }

   try {
      if (path.extname(c) !== '.json') {
        console.log('error: server (config_file) file must be .json');
        process.exit();
      }
      const data = fs.readFileSync(path.resolve(c), 'utf8');
      filec = JSON.parse(data).server;
    } catch (err) {
      console.error('Error:', err);
    }

  }

  // Check if object config provided to arg1
  else if (typeof c === 'object') {
    objc = c;
  }

  // Error on wrong arg1 type
  else {
    console.log('error: wrong type provided to server(arg1)..');
  }

  return {

    // server.start()
    start: async function() {

      // Default config, package.json config, file config, object config
      config = {...dc, ...pkgc, ...filec, ...objc};

      console.log(config);

      // Create and Start server using { config }

      return console.log(`start() still processing data. no return yet...`)
    }

  }
  
};