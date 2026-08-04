// QPURT API
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import pkg from "./package.json" with { type: 'json' };
import __dirname from './lib/path/__dirname.js';
import file_serve from './lib/fs/file_serve.js';

let entry = 'qpurt.json';
let _server, pkgc, filec, objc, config;

let dc = {
  port: 3000,
  static: 'public',
  functions: 'functions',
  watch: true
}

// New file exists function
function file_exists(filepath, mode = fs.constants.F_OK) {
  try {
    fs.accessSync(filepath, mode);
    return true;
  } catch {
    return false;
  }
}

export function server(c=dc) {

  // Check if package.json has qpConfig.server
  if (pkg.qpConfig && pkg.qpConfig.server) pkgc = pkg.qpConfig.server;
  // Check if qpurt.json exists in project root directory
  if (file_exists(path.resolve(entry))) { 
       try {
        const data = fs.readFileSync(path.resolve(entry), 'utf8');
        filec = JSON.parse(data).server;
      } catch (err) {
        console.error('Error:', err);
      }
  }

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
  else if (typeof c === 'object') objc = c;

  // Error: wrong server(arg1) type
  else {
    console.log('error: wrong type provided to server(arg1)..');
    process.exit();
  }

  // Merge config object options
  // Default config, package.json config, file config, object config
  config = {...dc, ...pkgc, ...filec, ...objc};

  // Set publicDir uring { config.static }
  const publicDir = path.join(__dirname(), config.static);
  const publicDirResolved = path.resolve(publicDir);

  function safe_resolve(...segments) {
    const resolved = path.resolve(publicDir, ...segments);
    if (resolved !== publicDirResolved && !resolved.startsWith(publicDirResolved + path.sep)) {
      return null;
    }
    return resolved;
  };
  
  async function loadModule(m) {
    try {
      const module = await import(`${path.resolve(__dirname(), config.functions)}.js`);
      module.doSomething();
      console.log(module)
    } catch (err) {
      console.error('Failed to load module', err);
    }
  }

  (function qpurtServer (cfg=config) {
    _server = http.createServer(async (req, res) => {
      // Loop config routes
      cfg.routes.forEach(route => {
        // Function path for given req.route
        const funcPath = path.resolve(cfg.functions, route.func+'.js');
        if (req.url === route.url) {
          if (!file_exists(funcPath)) {
            console.log(`error: route ${route.url} has a function {${route.func}} does not exist..`);
            process.exit();
          }
          // If file exists, import it and call it for the given req.url.
          import(pathToFileURL(funcPath).href).then(module => module.default(req, res)).catch(err => {
            console.error(`error: failed to load function ${route.func}`);
            console.error(err);
          });
        }
      });
    
      const parsed = new URL(req.url, `http://${req.headers.host}`);
      let pathname = decodeURIComponent(parsed.pathname);
    
      // Redirect *.html -> clean URL (only for HTML; other assets keep their extension)
      if (pathname.endsWith('.html')) {
        let clean = pathname.slice(0, -5);
        if (path.basename(clean) === 'index') {
          clean = path.dirname(clean) + '/';
        }
        res.writeHead(301, { Location: clean + parsed.search });
        res.end();
        return;
      }
    
      // If the request has a non-html extension (.css, .js, .png, etc), serve it directly
      const ext = path.extname(pathname);
      if (ext && ext !== '.html') {
        const filePath = safe_resolve('.' + pathname);
        if (!filePath) {
          res.writeHead(400);
          res.end('Bad request');
          return;
        }
        if (file_exists(filePath)) {
          file_serve(res, filePath);
          return;
        }
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    
      // No extension: try directory-style index, then flat .html file
      const indexCandidate = safe_resolve('.' + pathname, 'index.html');
      const flatCandidate = safe_resolve('.' + pathname + '.html');
      const candidates = [indexCandidate, flatCandidate].filter(Boolean);
    
      if (candidates.length === 0) {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }
      
      for (const filePath of candidates) {
        if (file_exists(filePath)) {
          file_serve(res, filePath);
          return;
        }
      }
    
      res.writeHead(404);
      res.end('Not found');
    });

  })();

  // Return qpurt.server methods
  return {

    // qpurt.server.start()
    start: async function() {

      if (!config.watch) {
        _server.listen(config.port, () => {
          console.log(`Server running on port: ${config.port}`);
        })
      } 
      else {
        console.log('run with watch options instead...')
        console.log(_server)
        // // --- Config ---
        // const ENTRY = './server/server.start.js';
        // const WATCH_PATHS = ['./']; // multiple watch roots
        // const IGNORE_PATTERNS = [
        //   /node_modules/,
        //   /\.git/,
        //   /dist/,
        //   /\.log$/,
        //   /\.tmp$/,
        // ];
        // const DEBOUNCE_MS = 150;
        
        // let child;
        // let restartTimer = null;
        
        // function isIgnored(filename) {
        //   if (!filename) return false;
        //   const normalized = filename.split(path.sep).join('/');
        //   return IGNORE_PATTERNS.some((pattern) => pattern.test(normalized));
        // }
        
        // function start() {
        //   child = spawn('node', [ENTRY], { stdio: 'inherit' });
        // }
        
        // function restart() {
        //   if (child) child.kill();
        //   start();
        // }
        
        // function scheduleRestart(filename) {
        //   console.log(`${filename} changed, restarting...`);
        //   clearTimeout(restartTimer);
        //   restartTimer = setTimeout(restart, DEBOUNCE_MS);
        // }
        
        // function watchPath(watchPath) {
        //   fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
        //     if (isIgnored(filename)) return;
        //     scheduleRestart(filename);
        //   });
        // }

        // WATCH_PATHS.forEach(watchPath);
        // start();
      }

    },

  };
  
};