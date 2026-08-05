// QPURT API
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import http from 'node:http';
import https from 'node:https';

// Read the *caller's* package.json (not qpurt's own) at runtime, relative to
// the current working directory. A static `import "./package.json"` would
// resolve relative to this file's own location instead -- which breaks the
// moment qpurt.js isn't sitting directly next to your project's
// package.json (e.g. it's nested in a subfolder or installed as a
// dependency), throwing ERR_MODULE_NOT_FOUND before server() ever runs.
function readPkg() {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return {};
  }
}

// ---- Environment resolution ------------------------------------------------
// Determines dev vs prod (or any custom env name, e.g. "staging") so config
// files can carry per-environment overrides without maintaining separate
// qpurt.json files. Priority: explicit `env` on the object passed to
// server(), then NODE_ENV, then QPURT_ENV, then "development" by default --
// matching the common convention that unset means "not production".
function resolveEnv(c) {
  const raw =
    (c && typeof c === 'object' && c.env) ||
    process.env.NODE_ENV ||
    process.env.QPURT_ENV ||
    'development';
  const normalized = String(raw).toLowerCase();
  if (normalized.startsWith('prod')) return 'production';
  if (normalized.startsWith('dev')) return 'development';
  return normalized; // custom env names (e.g. "staging") pass through as-is
}

// Merges a config section's environment-agnostic base with its
// environment-specific override block, e.g. given
//   { server: { port: 3000 }, production: { port: 443, tls: {...} } }
// and env "production", returns { port: 443, tls: {...} }.
function mergeEnvSection(parsed, env) {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const base = parsed.server || {};
  const override = parsed[env] || {};
  return { ...base, ...override };
}

let _server, _redirectServer, pkgc, filec, objc, config, entry = 'qpurt.json';

// Last-resort safety net. These should be rare if route handlers are
// correct, but an uncaught error here would otherwise crash the process
// with no explanation, or in some Node versions leave it in a half-dead
// state. Log clearly and exit so a process manager (systemd/pm2/Docker
// restart policy) can restart cleanly -- don't try to keep running after
// state may be corrupted.
process.on('uncaughtException', (err) => {
  console.error('[qpurt] uncaught exception, exiting:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[qpurt] unhandled promise rejection, exiting:', reason);
  process.exit(1);
});


let dc = {
  port: 3000,
  static: 'public',
  functions: 'functions',
  watch: true,
  // Extra paths to watch besides `functions` (files or directories).
  watchPaths: [],
  // Glob-style patterns (relative to project root) to exclude from
  // triggering a reload, e.g. ['**/*.test.js', 'functions/tmp/**'].
  watchIgnore: ['**/node_modules/**', '**/.git/**'],
  // Only trigger reloads for files with these extensions (leading dot
  // optional, case-insensitive), e.g. ['.js', '.mjs', '.json']. Empty
  // array (default) means no extension filtering -- all files count.
  watchExtensions: [],
  // Max time (ms) a route function is given to write a response before
  // qpurt gives up and sends a 504, instead of hanging forever if a
  // handler forgets to call res.end() or awaits something that never
  // resolves. Set to 0 to disable.
  routeTimeout: 10000,
  // Absolute-path segments (case-insensitive) that block a static file from
  // being served even if it resolves inside `static`, e.g. dotfiles and
  // common secrets. Set to [] to disable (not recommended).
  blockedPatterns: [
    /(^|\/)\./,                          // dotfiles/dot-directories: .env, .git/*, .htpasswd
    /\.(pem|key|p12|pfx)$/i,             // certs/private keys
    /\.(sql|sqlite|db)$/i,               // database dumps
    /\.(bak|backup|old|swp)$/i           // editor/backup leftovers
  ],
  // Basic security response headers applied to every response. Set to null
  // or {} to disable.
  securityHeaders: {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer-when-downgrade'
  },
  // Built-in http.Server hardening against slow-connection (Slowloris-style)
  // attacks. All are plain Node http.Server options, no dependency needed.
  headersTimeout: 20000,   // ms allowed to receive the full request headers
  requestTimeout: 30000,   // ms allowed to receive the full request
  keepAliveTimeout: 5000,  // ms an idle keep-alive connection is held open
  maxHeadersCount: 100,    // hard cap on header count per request
  maxConnections: 500,     // hard cap on concurrent sockets; 0 = unlimited

  // TLS. Set to enable HTTPS directly -- no reverse proxy needed. Paths are
  // relative to the project root (process.cwd()). `port` above becomes the
  // HTTPS port (443 typically needs root or setcap on Linux).
  //   tls: { cert: 'certs/fullchain.pem', key: 'certs/privkey.pem', ca: null }
  tls: null,
  // Automatically reload the cert/key from disk when the files change (e.g.
  // `certbot renew` swaps them in-place), without restarting the process.
  watchTls: true,
  // When TLS is enabled, also start a small plain-HTTP listener on this
  // port that (a) serves ACME HTTP-01 challenge files from
  // `<static>/.well-known/acme-challenge/` so `certbot --webroot` works
  // without a proxy, and (b) 301-redirects everything else to HTTPS.
  // Set to 0 to disable this secondary listener entirely.
  httpPort: 80,
  httpsRedirect: true,
  // Explicit escape hatch: forces plain HTTP even if `tls` is configured
  // (e.g. useful if `tls` lives in the shared base config and you only
  // want to disable it for one environment). Normally you'd just omit
  // `tls` from the dev override block instead -- see server(c) docs.
  forceHttp: false
};

const _DEFAULT_MIME = 'application/octet-stream';
const _MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
};

function get_mime_types(filePath) {
  return _MIME_TYPES[
    path.extname(filePath).toLowerCase()
  ] || _DEFAULT_MIME;
};

function file_serve(res, filePath) {
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, { 'Content-Type': get_mime_types(filePath) });
  stream.pipe(res);
  stream.on('error', () => {
    res.writeHead(500);
    res.end('Server error');
  });
};

function file_exists(filepath, mode = fs.constants.F_OK) {
  try {
    fs.accessSync(filepath, mode);
    return true;
  } catch {
    return false;
  }
};

// ---- TLS ---------------------------------------------------------------
// Loads cert/key (and optional CA) from disk, relative to the project root.
// Throws with a clear message on missing/unreadable files rather than
// letting https.createServer fail with an opaque error.
function loadTlsOptions(tlsCfg) {
  const certPath = path.resolve(process.cwd(), tlsCfg.cert);
  const keyPath = path.resolve(process.cwd(), tlsCfg.key);

  if (!file_exists(certPath)) {
    throw new Error(`[qpurt] tls.cert not found: ${certPath}`);
  }
  if (!file_exists(keyPath)) {
    throw new Error(`[qpurt] tls.key not found: ${keyPath}`);
  }

  const options = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  };

  if (tlsCfg.ca) {
    const caPath = path.resolve(process.cwd(), tlsCfg.ca);
    if (file_exists(caPath)) options.ca = fs.readFileSync(caPath);
  }

  return options;
}

// Watches the directories containing the cert/key files (not the files
// themselves) and hot-swaps the TLS context on change via
// server.setSecureContext(). Watching the parent directory, not the file,
// matters because tools like certbot typically renew via an atomic
// rename/symlink-swap, which a watch on the file path itself can miss on
// Linux (inotify loses the watch when the underlying inode is replaced).
function watchTlsFiles(server, tlsCfg) {
  const dirs = new Set([
    path.dirname(path.resolve(process.cwd(), tlsCfg.cert)),
    path.dirname(path.resolve(process.cwd(), tlsCfg.key))
  ]);

  let reloadTimer = null;
  const scheduleReload = () => {
    // Debounce: a renewal touches multiple files in quick succession.
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        const fresh = loadTlsOptions(tlsCfg);
        server.setSecureContext(fresh);
        console.log('[qpurt] TLS certificate reloaded.');
      } catch (err) {
        console.error('[qpurt] failed to reload TLS certificate, keeping previous one:', err);
      }
    }, 500);
  };

  for (const dir of dirs) {
    if (!file_exists(dir)) continue;
    try {
      fs.watch(dir, scheduleReload);
    } catch (err) {
      console.error(`[qpurt] failed to watch TLS cert directory ${dir}:`, err);
    }
  }
}

// Minimal plain-HTTP server used only when TLS is enabled. Serves ACME
// HTTP-01 challenge files (so `certbot --webroot` works with zero proxy)
// and 301-redirects everything else to HTTPS.
function startHttpRedirectServer(cfg) {
  const publicDir = path.join(process.cwd(), cfg.static);
  const publicDirResolved = path.resolve(publicDir);

  const redirectServer = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(parsed.pathname);

    if (pathname.startsWith('/.well-known/acme-challenge/')) {
      const resolved = path.resolve(publicDir, '.' + pathname);
      const inBounds = resolved === publicDirResolved ||
        resolved.startsWith(publicDirResolved + path.sep);
      if (inBounds && file_exists(resolved)) {
        // ACME challenge files are plain tokens -- serve as text, no need
        // for MIME sniffing.
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        fs.createReadStream(resolved).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (!cfg.httpsRedirect) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const host = (req.headers.host || '').split(':')[0];
    const portSuffix = cfg.port === 443 ? '' : `:${cfg.port}`;
    res.writeHead(301, { Location: `https://${host}${portSuffix}${req.url}` });
    res.end();
  });

  redirectServer.headersTimeout = cfg.headersTimeout;
  redirectServer.requestTimeout = cfg.requestTimeout;
  redirectServer.keepAliveTimeout = cfg.keepAliveTimeout;

  redirectServer.listen(cfg.httpPort, () => {
    console.log(
      `[qpurt] HTTP listener on port ${cfg.httpPort} ` +
      `(ACME challenges${cfg.httpsRedirect ? ' + redirect to HTTPS' : ''})`
    );
  });
  redirectServer.on('error', (err) => {
    console.error(`[qpurt] failed to start HTTP redirect listener on port ${cfg.httpPort}:`, err);
  });

  _redirectServer = redirectServer;
  return redirectServer;
}

// ---- Ignore-pattern matching -----------------------------------------------
// Small dependency-free glob matcher supporting `*` (any chars, not `/`),
// `**` (any chars, including `/`), and `?` (single char). Patterns and the
// path being tested are both normalized to forward slashes and matched
// relative to the project root, so `**/*.test.js` or `functions/tmp/**`
// behave the way you'd expect from .gitignore-style globs.

function globToRegExp(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        out += '.*';
        i++;
        // swallow an optional following slash so `**/` can match zero dirs
        if (normalized[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

function isIgnored(absPath, ignorePatterns, root) {
  if (!ignorePatterns || ignorePatterns.length === 0) return false;
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  return ignorePatterns.some(pattern => globToRegExp(pattern).test(rel));
}

// ---- Hot-reload machinery -------------------------------------------------
// Node caches ES module imports by resolved URL, so re-importing the same
// path after an edit returns the stale cached module. We bust the cache by
// appending a version query string that changes whenever the file changes.

const _funcVersions = new Map();
let _watchersStarted = false;

function bumpVersion(filePath) {
  _funcVersions.set(filePath, (_funcVersions.get(filePath) || 0) + 1);
}

function importFresh(filePath) {
  const v = _funcVersions.get(filePath) || 0;
  const href = url.pathToFileURL(filePath).href;
  return import(v ? `${href}?v=${v}` : href);
}

function normalizeExtensions(exts) {
  if (!exts || exts.length === 0) return null;
  return new Set(
    exts.map(e => (e.startsWith('.') ? e : '.' + e).toLowerCase())
  );
}

function extensionAllowed(filePath, allowedExts) {
  if (!allowedExts) return true; // no filter configured -- everything counts
  return allowedExts.has(path.extname(filePath).toLowerCase());
}

function watchPath(root, targetPath, ignorePatterns, allowedExts) {
  const resolved = path.resolve(targetPath);
  if (!file_exists(resolved)) {
    console.log(`[qpurt] warning: watch path does not exist, skipping: ${resolved}`);
    return;
  }

  try {
    // recursive watching is native on macOS/Windows; on Linux, fs.watch only
    // honors `recursive` for the directory itself, not guaranteed for deep
    // subfolders — swap for chokidar if you need reliable recursive watching
    // there.
    fs.watch(resolved, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const changed = path.resolve(resolved, filename);

      if (!extensionAllowed(changed, allowedExts)) return;
      if (isIgnored(changed, ignorePatterns, root)) return;

      bumpVersion(changed);
      console.log(`[qpurt] reloaded ${path.relative(root, changed)}`);
    });
  } catch (err) {
    console.error(`[qpurt] failed to watch ${resolved}:`, err);
  }
}

function startWatcher(cfg) {
  if (_watchersStarted) return;
  _watchersStarted = true;

  const root = process.cwd();
  const ignorePatterns = cfg.watchIgnore || [];
  const allowedExts = normalizeExtensions(cfg.watchExtensions);

  // Watch the functions dir plus any extra paths the user configured.
  const paths = [cfg.functions, ...(cfg.watchPaths || [])].filter(Boolean);
  const seen = new Set();

  for (const p of paths) {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    watchPath(root, resolved, ignorePatterns, allowedExts);
  }

  const entryPath = path.resolve(entry);
  if (file_exists(entryPath) && !isIgnored(entryPath, ignorePatterns, root)) {
    fs.watch(entryPath, () => {
      try {
        const data = fs.readFileSync(entryPath, 'utf8');
        const next = JSON.parse(data).server;
        // mutate in place -- reassigning `config` would orphan any closure
        // (like the request handler below) that already captured the old
        // object reference.
        Object.assign(config, next);
        console.log('[qpurt] config reloaded');
      } catch (err) {
        console.error('[qpurt] failed to reload config:', err);
      }
    });
  }
}

export function server(c) {

  const resolvedEnv = resolveEnv(c);

  const pkg = readPkg();
  if (pkg.qpConfig) pkgc = mergeEnvSection(pkg.qpConfig, resolvedEnv);

  if (file_exists(path.resolve(entry))) {
    try {
      const data = fs.readFileSync(path.resolve(entry), 'utf8');
      filec = mergeEnvSection(JSON.parse(data), resolvedEnv);
    } catch (err) {
      console.error('Error:', err);
    }
  }

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
      filec = mergeEnvSection(JSON.parse(data), resolvedEnv);
    } catch (err) {
      console.error('Error:', err);
    }

  }
  // No argument at all -- use defaults + package.json + qpurt.json only.
  else if (c === undefined) { /* objc stays unset */ }
  else if (typeof c === 'object' && c !== null) objc = c;
  else {
    console.log('error: wrong type provided to server(arg1)..');
    process.exit();
  }


  // Default config, package.json config, file config, object config.
  // `env` is set last so it always reflects the actually-resolved value,
  // regardless of what any layer happened to contain.
  config = { ...dc, ...pkgc, ...filec, ...objc, env: resolvedEnv };

  const publicDir = path.join(process.cwd(), config.static);
  const publicDirResolved = path.resolve(publicDir);

  function safe_resolve(...segments) {
    const resolved = path.resolve(publicDir, ...segments);
    if (resolved !== publicDirResolved && !resolved.startsWith(publicDirResolved + path.sep)) {
      return null;
    }
    const rel = path.relative(publicDir, resolved).split(path.sep).join('/');
    // Explicit allowlist exception: ACME HTTP-01 challenge files live under
    // a dot-prefixed path by spec (.well-known/acme-challenge/<token>) and
    // must be servable even though blockedPatterns blocks dotfiles.
    const isAcmeChallenge = rel.startsWith('.well-known/acme-challenge/');
    if (!isAcmeChallenge) {
      const blocked = (config.blockedPatterns || []).some(pattern => pattern.test(rel));
      if (blocked) return null;
    }
    return resolved;
  };

  const requestHandler = async (req, res) => {
    // Apply baseline security headers to every response up front via
    // setHeader (not writeHead) so they survive no matter which code path
    // eventually calls res.writeHead()/res.end() below.
    for (const [k, v] of Object.entries(config.securityHeaders || {})) {
      res.setHeader(k, v);
    }
    // HSTS only makes sense once TLS is actually serving the response --
    // sending it over plain HTTP would be a lie the browser can't verify.
    if (useTls) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }

    // Always read from the live `config` object (not a snapshot) so
    // watcher-driven reloads of qpurt.json take effect immediately.
    const routes = config.routes || [];

    for (const route of routes) {
      if (req.url !== route.url) continue;

      const funcPath = path.resolve(config.functions, route.func + '.js');
      if (!file_exists(funcPath)) {
        console.log(`error: route ${route.url} has a function {${route.func}} that does not exist..`);
        res.writeHead(500);
        res.end('Server error');
        return;
      }

      try {
        const module = await importFresh(funcPath);
        const handlerPromise = Promise.resolve(module.default(req, res));

        if (config.routeTimeout > 0) {
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            if (!res.headersSent) {
              console.error(
                `[qpurt] route "${route.url}" (${route.func}) did not respond ` +
                `within ${config.routeTimeout}ms -- check for a missing res.end() ` +
                `or an unresolved await in that handler.`
              );
              res.writeHead(504);
              res.end('Gateway Timeout: route handler did not respond in time');
            } else if (!res.writableEnded) {
              console.error(
                `[qpurt] route "${route.url}" (${route.func}) started a response ` +
                `but never finished it (missing res.end()?).`
              );
            }
          }, config.routeTimeout);

          await handlerPromise;
          clearTimeout(timer);

          if (!timedOut && !res.writableEnded && !res.headersSent) {
            console.error(
              `[qpurt] route "${route.url}" (${route.func}) returned without ` +
              `sending a response -- did you forget res.end()?`
            );
          }
        } else {
          await handlerPromise;
        }
      } catch (err) {
        console.error(`error: failed to load function ${route.func}`);
        console.error(err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Server error');
        }
      }
      return;
    }

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
  };

  const useTls = !config.forceHttp && !!(config.tls && config.tls.cert && config.tls.key);
  if (useTls) {
    const tlsOptions = {
      ...loadTlsOptions(config.tls),
      // Explicit floor even though Node already defaults to TLSv1.2+ --
      // pinning it here means the minimum can't silently drift if Node's
      // own default ever changes, or if someone adds conflicting options
      // to config.tls later.
      minVersion: 'TLSv1.2'
    };
    _server = https.createServer(tlsOptions, requestHandler);
  } else {
    _server = http.createServer(requestHandler);
  }

  // Return qpurt.server methods
  return {

    // qpurt.server.start()
    start: async function () {
      // Slowloris-style hardening -- built into Node's http.Server, no
      // dependency required. See config comments above for what each does.
      _server.headersTimeout = config.headersTimeout;
      _server.requestTimeout = config.requestTimeout;
      _server.keepAliveTimeout = config.keepAliveTimeout;
      _server.maxHeadersCount = config.maxHeadersCount;
      if (config.maxConnections) _server.maxConnections = config.maxConnections;

      _server.listen(config.port, () => {
        console.log(`[qpurt] running in ${config.env} mode`);
        console.log(`Server running on port: ${config.port}${useTls ? ' (https)' : ''}`);
        if (config.env === 'production' && !useTls && !config.forceHttp) {
          console.warn(
            '[qpurt] running in production without TLS configured -- traffic ' +
            'is unencrypted. If this is intentional (e.g. TLS is terminated ' +
            'upstream by a CDN/load balancer), set "forceHttp": true in your ' +
            'production config to silence this warning.'
          );
        }
        if (useTls) {
          if (config.watchTls) {
            watchTlsFiles(_server, config.tls);
            console.log('[qpurt] watching TLS cert/key for renewal...');
          }
          if (config.httpPort) {
            startHttpRedirectServer(config);
          }
        }
        if (config.watch) {
          startWatcher(config);
          const watched = [config.functions, ...(config.watchPaths || [])].filter(Boolean);
          console.log(`[qpurt] watching for changes in: ${watched.join(', ')}`);
          if (config.watchIgnore && config.watchIgnore.length) {
            console.log(`[qpurt] ignoring: ${config.watchIgnore.join(', ')}`);
          }
          if (config.watchExtensions && config.watchExtensions.length) {
            console.log(`[qpurt] only watching extensions: ${config.watchExtensions.join(', ')}`);
          }
          console.warn(
            '[qpurt] watch mode is on -- each reload leaks the previous module ' +
            'instance from Node\'s import cache. Fine for local dev; set ' +
            '"watch": false in production to avoid unbounded memory growth.'
          );
        }
      });

      // Graceful shutdown: stop accepting new connections and let in-flight
      // requests finish before exiting, instead of dying mid-response when
      // the process manager (Docker/systemd/k8s) sends SIGTERM on redeploy.
      const shutdown = (signal) => {
        console.log(`[qpurt] received ${signal}, shutting down gracefully...`);
        let pending = 1;
        const done = () => { if (--pending <= 0) { console.log('[qpurt] all connections closed, exiting.'); process.exit(0); } };
        _server.close(done);
        if (_redirectServer) {
          pending++;
          _redirectServer.close(done);
        }
        // Don't wait forever for slow/hung connections to drain.
        setTimeout(() => {
          console.warn('[qpurt] forced shutdown after timeout.');
          process.exit(1);
        }, 10000).unref();
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    },

  };

};
