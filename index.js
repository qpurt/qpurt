// QPURT API
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pkg from "./package.json" with { type: 'json' };
import __dirname from './lib/path/__dirname.js';
import file_serve from './lib/fs/file_serve.js';

let pkgc, filec, objc, config;

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
  // Return qpurt.server methods
  return {

    // qpurt.server.start()
    start: async function() {

      const server = http.createServer(async (req, res) => {
        config.routes.forEach(route => {
          if (req.url === route.url) {
            console.log(route.func)
            const handler = await import(path.resolve(__dirname(), config.functions, route.func, '.js'));
            console.log(handler)
            // if (handler) handler(req, res);
            // else console.log('invalid url: '+ req.url);
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

      server.listen(config.port, () => {
        console.log(`Server running at port: ${config.port}`);
      });

    },

  };
  
};