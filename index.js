// QPURT API
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);

// Read the *caller's* package.json (not qpurt's own) at runtime, relative to
// the current working directory. A static `import "./package.json"` would
// resolve relative to this file's own location instead -- which breaks the
// moment qpurt.js isn't sitting directly next to your project's
// package.json (e.g. it's nested in a subfolder or installed as a
// dependency), throwing ERR_MODULE_NOT_FOUND before server() ever runs.
// Docs: fs.readFileSync https://nodejs.org/api/fs.html#fsreadfilesyncpath-options
//       path.resolve    https://nodejs.org/api/path.html#pathresolvepaths
//       process.cwd()   https://nodejs.org/api/process.html#processcwd
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
// Docs: process.env https://nodejs.org/api/process.html#processenv
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

const entry = 'qpurt.json';
let _server, _redirectServer, pkgc, filec, objc, config;

// Last-resort safety net. These should be rare if route handlers are
// correct, but an uncaught error here would otherwise crash the process
// with no explanation, or in some Node versions leave it in a half-dead
// state. Log clearly and exit so a process manager (systemd/pm2/Docker
// restart policy) can restart cleanly -- don't try to keep running after
// state may be corrupted.
// Docs: 'uncaughtException'   https://nodejs.org/api/process.html#event-uncaughtexception
//       'unhandledRejection'  https://nodejs.org/api/process.html#event-unhandledrejection
//       process.exit          https://nodejs.org/api/process.html#processexitcode
process.on('uncaughtException', (err) => {
  console.error('[qpurt] uncaught exception, exiting:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[qpurt] unhandled promise rejection, exiting:', reason);
  process.exit(1);
});


const dc = {
  port: 3000,
  static: 'public',
  functions: 'functions',
  watch: true,
  // fs.watch's `recursive` option isn't reliably honored for deep
  // subfolders on Linux (it's native on macOS/Windows). On Linux, qpurt
  // tries to use chokidar instead for the functions/watchPaths hot-reload
  // watcher, installing it on first use if it isn't already present.
  //
  // NOTE ON "ZERO DEPENDENCIES": with this on (the default), qpurt is not
  // strictly zero-dependency at runtime -- on Linux it can shell out to
  // `npm install chokidar` and load it. What IS still true: chokidar is
  // never declared anywhere (installed with --no-save, so package.json
  // and any lockfile stay untouched -- it's invisible to the dependency
  // tree and to anyone else who clones the project and runs `npm
  // install`), and if the install can't happen or fails for any reason,
  // qpurt falls back to the original pure-fs.watch behavior rather than
  // erroring. So: zero *declared* dependencies with a self-healing
  // optional one, not zero dependencies, full stop. If that distinction
  // matters for your deployment, set this to false -- see below.
  //
  // Set to false to always use fs.watch instead and guarantee qpurt never
  // touches node_modules on its own -- e.g. in a locked-down environment,
  // or one that's genuinely offline, or if the zero-dependency property
  // needs to hold in the strict sense. Has no effect on macOS/Windows,
  // where fs.watch is already reliable, or if chokidar is already
  // installed (then it's just used, no install attempted).
  autoInstallChokidar: true,
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
  // Docs: X-Content-Type-Options https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Content-Type-Options
  //       X-Frame-Options        https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options
  //       Referrer-Policy        https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy
  // Docs: Permissions-Policy https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy
  // Note: Content-Security-Policy is deliberately NOT set here -- a good
  // CSP is site-specific (inline scripts, third-party embeds, etc. all
  // affect it) and a wrong default is more likely to break your site than
  // help it. Add one in your own `securityHeaders` override once you know
  // what your pages actually load.
  securityHeaders: {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer-when-downgrade',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  },
  // Built-in http.Server hardening against slow-connection (Slowloris-style)
  // attacks. All are plain Node http.Server options, no dependency needed.
  // Docs: headersTimeout   https://nodejs.org/api/http.html#serverheaderstimeout
  //       requestTimeout   https://nodejs.org/api/http.html#serverrequesttimeout
  //       keepAliveTimeout https://nodejs.org/api/http.html#serverkeepalivetimeout
  //       maxHeadersCount  https://nodejs.org/api/http.html#servermaxheaderscount
  //       maxConnections   https://nodejs.org/api/net.html#servermaxconnections
  headersTimeout: 20000,   // ms allowed to receive the full request headers
  requestTimeout: 30000,   // ms allowed to receive the full request
  keepAliveTimeout: 5000,  // ms an idle keep-alive connection is held open
  maxHeadersCount: 100,    // hard cap on header count per request
  maxConnections: 500,     // hard cap on concurrent sockets; 0 = unlimited

  // TLS. Set to enable HTTPS directly -- no reverse proxy needed. Paths are
  // relative to the project root (process.cwd()). `port` above becomes the
  // HTTPS port (443 typically needs root or setcap on Linux).
  //   tls: { cert: 'certs/fullchain.pem', key: 'certs/privkey.pem', ca: null }
  // Docs: https.createServer https://nodejs.org/api/https.html#httpscreateserveroptions-requestlistener
  tls: null,
  // Automatically reload the cert/key from disk when the files change (e.g.
  // `certbot renew` swaps them in-place), without restarting the process.
  // Docs: tls.Server.setSecureContext https://nodejs.org/api/tls.html#serversetsecurecontextoptions
  watchTls: true,
  // When TLS is enabled, also start a small plain-HTTP listener on this
  // port that (a) serves ACME HTTP-01 challenge files from
  // `<static>/.well-known/acme-challenge/` so `certbot --webroot` works
  // without a proxy, and (b) 301-redirects everything else to HTTPS.
  // Set to 0 to disable this secondary listener entirely.
  // Docs: ACME HTTP-01 challenge https://letsencrypt.org/docs/challenge-types/#http-01-challenge
  httpPort: 80,
  httpsRedirect: true,
  // Explicit escape hatch: forces plain HTTP even if `tls` is configured
  // (e.g. useful if `tls` lives in the shared base config and you only
  // want to disable it for one environment). Normally you'd just omit
  // `tls` from the dev override block instead -- see server(c) docs.
  forceHttp: false,

  // Per-IP request-rate limiting. `maxConnections` above caps concurrent
  // sockets, not request *rate* -- a single connection can still fire an
  // unbounded number of requests over a keep-alive socket. Off by default
  // (null) so existing setups behave exactly as before; set e.g.
  // `{ windowMs: 60000, max: 300 }` to allow 300 requests per IP per
  // rolling minute before responding 429. Deliberately simple/in-memory --
  // fine for a single instance behind no load balancer; for multi-instance
  // deployments use a shared store (e.g. Redis) in front of qpurt instead.
  rateLimit: null
};

const _DEFAULT_MIME = 'application/octet-stream';
// Docs: MIME types reference https://developer.mozilla.org/en-US/docs/Web/HTTP/MIME_types
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
  '.pdf': 'application/pdf'
};

function get_mime_types(filePath) {
  return _MIME_TYPES[
    path.extname(filePath).toLowerCase()
  ] || _DEFAULT_MIME;
};

// Docs: fs.createReadStream https://nodejs.org/api/fs.html#fscreatereadstreampath-options
//       stream.pipe         https://nodejs.org/api/stream.html#readablepipedestination-options
//       res.headersSent     https://nodejs.org/api/http.html#responseheaderssent
//
// SECURITY/STABILITY: headers are written before piping starts, so if the
// stream errors mid-read (permissions change, disk error, file deleted
// after the exists check), headers are already sent -- calling
// res.writeHead(500) again throws ERR_HTTP_HEADERS_SENT. Left unguarded,
// that uncaught throw hits the process-level uncaughtException handler
// above and takes the *entire server* down over a single bad file read.
function file_serve(res, filePath) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error(`[qpurt] error streaming ${filePath}:`, err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Server error');
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });
  res.writeHead(200, { 'Content-Type': get_mime_types(filePath) });
  stream.pipe(res);
};

// Docs: fs.accessSync https://nodejs.org/api/fs.html#fsaccesssyncpath-mode
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
// Docs: TLS options (cert/key/ca) https://nodejs.org/api/tls.html#tlscreatesecurecontextoptions
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
// Docs: fs.watch               https://nodejs.org/api/fs.html#fswatchfilename-options-listener
//       tls.Server.setSecureContext https://nodejs.org/api/tls.html#serversetsecurecontextoptions
//       inotify caveats (fs.watch "Availability" note) https://nodejs.org/api/fs.html#availability
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
// Docs: http.createServer https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener
//       URL                https://nodejs.org/api/url.html#class-url
//       301 Moved Permanently https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/301
function startHttpRedirectServer(cfg) {
  const publicDir = path.join(process.cwd(), cfg.static);
  const publicDirResolved = path.resolve(publicDir);

  const redirectServer = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    // SECURITY: decodeURIComponent throws URIError on malformed
    // percent-encoding (e.g. a request for "/%"). Uncaught, that would
    // propagate out of this synchronous listener and hit the
    // process-level uncaughtException handler -- letting one malformed
    // request crash the server. Docs: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/decodeURIComponent#exceptions
    let pathname;
    try {
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

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

// ---- Rate limiting ----------------------------------------------------------
// Simple in-memory sliding-window limiter keyed by remote address. Deliberately
// minimal (no external deps) -- see the `rateLimit` config comment for scope
// and limitations (single-instance only).
// Docs: net.Socket.remoteAddress https://nodejs.org/api/net.html#socketremoteaddress
function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> array of request timestamps (ms)

  // Periodically drop IPs with no recent activity so the map doesn't grow
  // forever under normal traffic. unref() so this timer never keeps the
  // process alive on its own.
  const sweepInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, timestamps] of hits) {
      if (timestamps[timestamps.length - 1] < cutoff) hits.delete(ip);
    }
  }, windowMs).unref();

  return {
    allow(req) {
      const ip = req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const cutoff = now - windowMs;
      const timestamps = (hits.get(ip) || []).filter(t => t > cutoff);
      timestamps.push(now);
      hits.set(ip, timestamps);
      return timestamps.length <= max;
    },
    _sweepInterval: sweepInterval // exposed for tests/shutdown, not used elsewhere
  };
}

// ---- Ignore-pattern matching -----------------------------------------------
// Small dependency-free glob matcher supporting `*` (any chars, not `/`),
// `**` (any chars, including `/`), and `?` (single char). Patterns and the
// path being tested are both normalized to forward slashes and matched
// relative to the project root, so `**/*.test.js` or `functions/tmp/**`
// behave the way you'd expect from .gitignore-style globs.
// Docs: gitignore pattern format (for comparison) https://git-scm.com/docs/gitignore#_pattern_format
//       RegExp                                     https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp

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

// Docs: path.relative https://nodejs.org/api/path.html#pathrelativefrom-to
function isIgnored(absPath, ignorePatterns, root) {
  if (!ignorePatterns || ignorePatterns.length === 0) return false;
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  return ignorePatterns.some(pattern => globToRegExp(pattern).test(rel));
}

// ---- Hot-reload machinery -------------------------------------------------
// Node caches ES module imports by resolved URL, so re-importing the same
// path after an edit returns the stale cached module. We bust the cache by
// appending a version query string that changes whenever the file changes.
// Docs: dynamic import()   https://nodejs.org/api/esm.html#import-expressions
//       url.pathToFileURL  https://nodejs.org/api/url.html#urlpathtofileurlpath-options
//       ESM module caching (per-URL, not re-evaluated on identical import) https://nodejs.org/api/esm.html#modules-ecmascript-modules

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

// ---- Watcher backend (chokidar vs fs.watch) --------------------------------
// fs.watch's `recursive` option is native on macOS/Windows but not reliably
// honored for deep subfolders on Linux (inotify-based, no built-in recursive
// mode -- see the fs.watch "Availability" notes linked above). chokidar
// papers over that with its own recursive directory walking, so on Linux we
// prefer it for the functions/watchPaths hot-reload watcher and install it
// on first use if it's missing.
//
// This is qpurt's one and only place where an external package can enter
// the picture, and it's deliberately narrow: nothing else in this file
// imports anything beyond Node core. Two things are still true even with
// this in place -- (1) the install uses --no-save, so chokidar is never
// written to package.json/lockfile and stays invisible to the caller's own
// dependency tree, and (2) every code path here has a working fs.watch
// fallback, so a failed or declined install degrades gracefully rather than
// erroring. What's NOT true is a strict "zero dependencies, full stop"
// claim -- on Linux, with the default config, qpurt can and will run `npm
// install` on its own. Set `autoInstallChokidar: false` (see config above)
// if that needs to never happen in your deployment.
//
// Resolution result is cached at module scope (`_chokidar`) so the install
// is attempted at most once per process, even if multiple paths are watched.
// Docs: chokidar https://github.com/paulmillr/chokidar
//       npm install https://docs.npmjs.com/cli/v10/commands/npm-install
let _chokidar; // undefined = not yet resolved, null = unavailable/declined, module = ready
let _chokidarResolving;

async function resolveChokidar(cfg) {
  if (_chokidar !== undefined) return _chokidar;
  // Concurrent callers (multiple watched paths resolving at once) share one
  // in-flight resolution instead of each attempting their own install.
  if (_chokidarResolving) return _chokidarResolving;

  _chokidarResolving = (async () => {
    if (process.platform !== 'linux') {
      // fs.watch's recursive mode is already reliable here -- no need to
      // add a dependency.
      _chokidar = null;
      return null;
    }

    try {
      _chokidar = await import('chokidar');
      return _chokidar;
    } catch {
      // not installed yet -- fall through to the install attempt below
    }

    if (!cfg.autoInstallChokidar) {
      console.log(
        '[qpurt] chokidar not installed and autoInstallChokidar is false -- ' +
        'using fs.watch (recursive subfolder changes on Linux may be missed).'
      );
      _chokidar = null;
      return null;
    }

    console.log('[qpurt] Linux detected and chokidar not found -- installing it in the background for reliable recursive watching...');
    try {
      // --no-save: installs into node_modules without touching the
      // caller's package.json/lockfile. It's still on disk for next
      // startup, so this only runs once per environment.
      //
      // Uses the async `exec` (not `execSync`) deliberately: npm install
      // can take several seconds, and execSync blocks Node's entire
      // single-threaded event loop for that whole time -- even called from
      // inside an async function, nothing else (including in-flight HTTP
      // requests) runs until it returns. exec runs npm in a child process
      // and only awaits its completion, so the server keeps serving
      // requests (via fs.watch, until chokidar is ready) while it installs.
      // Docs: child_process.exec https://nodejs.org/api/child_process.html#child_processexeccommand-options-callback
      const { stdout, stderr } = await exec('npm install chokidar --no-save', { cwd: process.cwd() });
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.error(stderr.trim());
      _chokidar = await import('chokidar');
      console.log('[qpurt] chokidar installed.');
      return _chokidar;
    } catch (err) {
      console.error(
        '[qpurt] failed to install/load chokidar, falling back to fs.watch ' +
        '(recursive subfolder changes on Linux may be missed):', err.message
      );
      _chokidar = null;
      return null;
    }
  })();

  return _chokidarResolving;
}

// Watches `targetPath` recursively and calls onChange(absolutePath) for
// every change that passes the extension/ignore filters. Uses chokidar when
// available (see resolveChokidar above), otherwise fs.watch.
// Docs: fs.watch  https://nodejs.org/api/fs.html#fswatchfilename-options-listener
//       chokidar  https://github.com/paulmillr/chokidar#api
async function watchPath(root, targetPath, ignorePatterns, allowedExts, onChange, cfg) {
  const resolved = path.resolve(targetPath);
  if (!file_exists(resolved)) {
    console.log(`[qpurt] warning: watch path does not exist, skipping: ${resolved}`);
    return;
  }

  const chokidar = await resolveChokidar(cfg);

  if (chokidar) {
    const watcher = chokidar.watch(resolved, {
      ignoreInitial: true,
      ignored: (filePath) => isIgnored(path.resolve(filePath), ignorePatterns, root)
    });
    watcher.on('all', (eventType, filePath) => {
      const changed = path.resolve(filePath);
      if (!extensionAllowed(changed, allowedExts)) return;
      onChange(changed);
    });
    watcher.on('error', (err) => console.error(`[qpurt] chokidar watch error for ${resolved}:`, err));
    return;
  }

  try {
    // recursive watching is native on macOS/Windows; on Linux this only
    // reliably covers the directory itself, not guaranteed for deep
    // subfolders. We only reach this path on Linux if chokidar was
    // unavailable and couldn't be installed (or autoInstallChokidar was
    // turned off) -- see resolveChokidar above.
    fs.watch(resolved, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const changed = path.resolve(resolved, filename);

      if (!extensionAllowed(changed, allowedExts)) return;
      if (isIgnored(changed, ignorePatterns, root)) return;

      onChange(changed);
    });
  } catch (err) {
    console.error(`[qpurt] failed to watch ${resolved}:`, err);
  }
}

async function startWatcher(cfg) {
  if (_watchersStarted) return;
  _watchersStarted = true;

  const root = process.cwd();
  const ignorePatterns = cfg.watchIgnore || [];
  const allowedExts = normalizeExtensions(cfg.watchExtensions);

  const onChange = (changed) => {
    bumpVersion(changed);
    console.log(`[qpurt] reloaded ${path.relative(root, changed)}`);
  };

  // Watch the functions dir plus any extra paths the user configured.
  const paths = [cfg.functions, ...(cfg.watchPaths || [])].filter(Boolean);
  const seen = new Set();

  for (const p of paths) {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    await watchPath(root, resolved, ignorePatterns, allowedExts, onChange, cfg);
  }

  const entryPath = path.resolve(entry);
  if (file_exists(entryPath) && !isIgnored(entryPath, ignorePatterns, root)) {
    // Single-file watch -- not subject to the recursive-subfolder caveat
    // above, so plain fs.watch is fine here regardless of platform.
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

// Docs: http.createServer  https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener
//       https.createServer https://nodejs.org/api/https.html#httpscreateserveroptions-requestlistener
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
  // Docs: object spread https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Spread_syntax
  config = { ...dc, ...pkgc, ...filec, ...objc, env: resolvedEnv };

  const publicDir = path.join(process.cwd(), config.static);
  const publicDirResolved = path.resolve(publicDir);

  const limiter = config.rateLimit ? createRateLimiter(config.rateLimit) : null;

  // Prevents path traversal (e.g. `../../etc/passwd`) by rejecting any
  // resolved path that falls outside `publicDir`, and enforces
  // `blockedPatterns` against the path relative to the static root.
  // Docs: path traversal (OWASP) https://owasp.org/www-community/attacks/Path_Traversal
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

  // Docs: http.IncomingMessage / http.ServerResponse https://nodejs.org/api/http.html#class-httpincomingmessage
  //       res.setHeader vs res.writeHead              https://nodejs.org/api/http.html#responsesetheadername-value
  const handleRequest = async (req, res) => {
    // Apply baseline security headers to every response up front via
    // setHeader (not writeHead) so they survive no matter which code path
    // eventually calls res.writeHead()/res.end() below.
    for (const [k, v] of Object.entries(config.securityHeaders || {})) {
      res.setHeader(k, v);
    }
    // HSTS only makes sense once TLS is actually serving the response --
    // sending it over plain HTTP would be a lie the browser can't verify.
    // Docs: Strict-Transport-Security https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security
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
                'or an unresolved await in that handler.'
              );
              res.writeHead(504);
              res.end('Gateway Timeout: route handler did not respond in time');
            } else if (!res.writableEnded) {
              console.error(
                `[qpurt] route "${route.url}" (${route.func}) started a response ` +
                'but never finished it (missing res.end()?).'
              );
            }
          }, config.routeTimeout);

          await handlerPromise;
          clearTimeout(timer);

          if (!timedOut && !res.writableEnded && !res.headersSent) {
            console.error(
              `[qpurt] route "${route.url}" (${route.func}) returned without ` +
              'sending a response -- did you forget res.end()?'
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
    // SECURITY: see the matching decodeURIComponent guard in
    // startHttpRedirectServer above -- same crash, same fix.
    let pathname;
    try {
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

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

  // SECURITY: last-line-of-defense wrapper. handleRequest already guards
  // its own known failure points, but this ensures *no* per-request error
  // -- known or not -- can escape to the process-level uncaughtException /
  // unhandledRejection handlers defined at module load time, which
  // deliberately exit(1). Without this, a single crafted or unlucky
  // request could take the entire server down; with it, at worst that one
  // request gets a 500.
  const requestHandler = async (req, res) => {
    if (limiter && !limiter.allow(req)) {
      res.writeHead(429, { 'Retry-After': String(Math.ceil(config.rateLimit.windowMs / 1000)) });
      res.end('Too Many Requests');
      return;
    }
    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error('[qpurt] unhandled error in request handler:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Server error');
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  };

  const useTls = !config.forceHttp && !!(config.tls && config.tls.cert && config.tls.key);
  if (useTls) {
    const tlsOptions = {
      ...loadTlsOptions(config.tls),
      // Explicit floor even though Node already defaults to TLSv1.2+ --
      // pinning it here means the minimum can't silently drift if Node's
      // own default ever changes, or if someone adds conflicting options
      // to config.tls later.
      // Docs: tls minVersion https://nodejs.org/api/tls.html#tlscreatesecurecontextoptions
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
      // dependency required. See config comments above for what each does,
      // and the Node docs linked there.
      // Docs: Slowloris (OWASP) https://owasp.org/www-community/attacks/Slowloris_HTTP_DoS
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
          startWatcher(config).catch((err) => {
            console.error('[qpurt] failed to start file watcher:', err);
          });
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
      // Docs: server.close    https://nodejs.org/api/http.html#serverclosecallback
      //       Signal events   https://nodejs.org/api/process.html#signal-events
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
    }

  };

};
