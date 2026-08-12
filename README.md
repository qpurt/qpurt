<p align="center">
  <img src="./docs/img/qpurt-v1-logo.png" alt="CLI Screenshot" width="100">
</p>

# qpurt

A single-file, zero-dependency Node.js HTTP(S) server. Static file
serving, file-based routes with hot reloading, built-in TLS with
auto-renewal pickup, ACME HTTP-01 support, security headers, rate
limiting, and Slowloris hardening.

Requires Node.js 18.20+, 20.11+, or 22+ (uses ES modules and
`fs.readdirSync(..., { withFileTypes: true })`).

## Install

Copy `qpurt.js` into your project. That's it. qpurt only imports Node core modules (`fs`, `path`,
`url`, `http`, `https`) and never shells out to `npm` or writes to
`node_modules` on its own.

For convenience and future CLI usage, an npm package is available:
```
npm install qpurt
```

## Quick start

```
myapp/
├── qpurt.js
├── start.js
├── public/
│   └── index.html
└── functions/
    └── hello.js
```

```js
// functions/hello.js
export default (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from a route function');
};
```

```js
// start.js
import { server } from './qpurt.js';

const s = server({
  routes: [{ url: '/hello', func: 'hello' }]
});

await s.start();
```

```
node start.js
```

Static files in `public/` are served automatically. Anything under
`functions/` that's wired up in `routes` is served as a route, and
edited files are hot-reloaded without a restart.

## Configuration

`server()` accepts either nothing, a config object, or a path to a
`.json` config file. Config is layered in this order (later wins):

1. Built-in defaults
2. `qpConfig` in your project's `package.json`
3. `qpurt.json` in the project root, if present
4. A config file path or object passed to `server(...)`, if given

Each layer can be a flat object or an environment-sectioned one --
see [Environments](#environments) below.

### `qpurt.json` example

```json
{
  "server": {
    "port": 3000,
    "static": "public",
    "functions": "functions",
    "routes": [
      { "url": "/hello", "func": "hello" },
      { "url": "/api/users", "func": "users" }
    ]
  },
  "production": {
    "port": 443,
    "watch": false,
    "tls": {
      "cert": "certs/fullchain.pem",
      "key": "certs/privkey.pem"
    }
  }
}
```

### Options

| Option | Default | Description |
|---|---|---|
| `port` | `3000` | Port to listen on (HTTPS port too, when TLS is on). |
| `static` | `'public'` | Directory static files are served from. |
| `functions` | `'functions'` | Directory route handler files live in. |
| `routes` | `[]` | Array of `{ url, func }` -- see [Routes](#routes). |
| `watch` | `true` | Hot-reload route handlers on change. Disable in production to avoid unbounded memory growth (see [Watch mode](#watch-mode--hot-reload)). |
| `watchPaths` | `[]` | Extra files/directories to watch besides `functions`. |
| `watchIgnore` | `['**/node_modules/**', '**/.git/**']` | Glob patterns (relative to project root) excluded from triggering a reload. |
| `watchExtensions` | `[]` | Only reload for these extensions (e.g. `['.js', '.json']`). Empty = all files. |
| `routeTimeout` | `10000` | Max ms a route handler has to respond before qpurt sends a `504`. `0` disables. |
| `blockedPatterns` | dotfiles, `.pem/.key/.p12/.pfx`, `.sql/.sqlite/.db`, `.bak/.backup/.old/.swp` | Regexes tested against the static-file path; matches are blocked even if the path resolves inside `static`. |
| `securityHeaders` | see below | Response headers applied to every request. `null`/`{}` disables. |
| `headersTimeout` | `20000` | ms allowed to receive full request headers. |
| `requestTimeout` | `30000` | ms allowed to receive the full request. |
| `keepAliveTimeout` | `5000` | ms an idle keep-alive connection stays open. |
| `maxHeadersCount` | `100` | Hard cap on header count per request. |
| `maxConnections` | `500` | Hard cap on concurrent sockets. `0` = unlimited. |
| `tls` | `null` | `{ cert, key, ca? }`, paths relative to project root. Enables HTTPS directly. |
| `watchTls` | `true` | Hot-swap the TLS context when cert/key files change on disk (e.g. `certbot renew`). |
| `httpPort` | `80` | Secondary plain-HTTP listener started when TLS is on -- serves ACME challenges and redirects to HTTPS. `0` disables it. |
| `httpsRedirect` | `true` | Whether the secondary HTTP listener 301s non-challenge requests to HTTPS. |
| `forceHttp` | `false` | Force plain HTTP even if `tls` is configured. |
| `rateLimit` | `null` | `{ windowMs, max }` -- per-IP request rate limit. `null` disables. |

Default `securityHeaders`:

```json
{
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer-when-downgrade",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
}
```

`Strict-Transport-Security` is added automatically when TLS is
active. A `Content-Security-Policy` is deliberately *not* set by
default -- a good CSP is site-specific, and a wrong default is more
likely to break your site than help it. Add your own via
`securityHeaders` once you know what your pages load.

## Routes

Wire a URL to a handler file with `routes: [{ url, func }]`. `func`
is a filename (without `.js`) inside your `functions` directory,
exporting a default function:

```js
// functions/users.js
export default async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ users: [] }));
};
```

Route matching is against the URL's **pathname only** -- a query
string doesn't need to be part of `url` and won't stop a match:

```json
{ "url": "/search", "func": "search" }
```

matches both `/search` and `/search?q=node`.

### Query parameters

Every request handler gets parsed query params on `req`:

- **`req.query`** -- a plain object, one value per key (last value
  wins on repeats). The common case:

  ```js
  export default (req, res) => {
    const { q } = req.query; // /search?q=node -> "node"
    res.end(`searching for ${q}`);
  };
  ```

- **`req.searchParams`** -- the full
  [`URLSearchParams`](https://nodejs.org/api/url.html#class-urlsearchparams)
  object, for repeated keys or anything beyond simple key/value
  (`.getAll()`, `.has()`, iteration, etc.):

  ```js
  // /search?tag=a&tag=b
  req.searchParams.getAll('tag'); // ['a', 'b']
  ```

### Route timeouts

If a handler doesn't call `res.end()` (or otherwise finish the
response) within `routeTimeout` ms, qpurt logs a warning and sends a
`504`. This catches a common bug class -- a missing `res.end()` or
an `await` on something that never resolves -- without hanging the
connection forever. Set `routeTimeout: 0` to disable.

### Errors in routes

A route function that throws (sync or async) is caught, logged, and
turned into a `500` if headers haven't been sent yet. A missing
handler file logs an error and responds `500` rather than crashing
the process.

## Static files

Anything not matched by `routes` falls through to static serving
from the `static` directory:

- Requests with a non-`.html` extension (`.css`, `.js`, `.png`, ...)
  are served directly, or `404` if missing.
- Requests for a `.html` path 301-redirect to the extension-less
  clean URL (`/about.html` → `/about`, `/index.html` → `/`).
- Extension-less requests try `<path>/index.html`, then
  `<path>.html`.
- Path traversal outside `static` is rejected. Paths matching
  `blockedPatterns` (dotfiles, key/cert files, DB dumps, editor
  backups) are blocked even when they'd otherwise resolve inside
  `static` -- with one deliberate exception for ACME challenge files
  (see [TLS](#tls--https)).

## Watch mode / hot reload

With `watch: true` (the default), qpurt watches `functions` (plus
`watchPaths`) for changes and hot-reloads edited route handlers with
no restart -- the next request to a changed route picks up the new
code.

This is implemented with a small dependency-free recursive directory
watcher (`DirTreeWatcher`), not a package like chokidar: qpurt walks
the watched tree itself and puts a plain `fs.watch` on every
subdirectory, keeping that set in sync as directories are created or
removed. This is what makes qpurt's zero-dependency story hold in
the strict sense on every platform, including Linux, where
`fs.watch`'s native `recursive: true` option isn't reliably honored
for deep subfolders.

**Turn `watch` off in production.** Each reload leaks the previous
module instance from Node's ES module import cache -- fine for a
dev session, but unbounded memory growth over a long-running
production process. qpurt logs a warning on startup if watch mode is
on.

`qpurt.json` itself is also watched (when it exists) and hot-reloads
config changes -- routes, headers, timeouts, etc. -- without a
restart.

## TLS / HTTPS

Set `tls: { cert, key, ca? }` (paths relative to the project root)
to terminate HTTPS directly, no reverse proxy required:

```json
{
  "tls": {
    "cert": "certs/fullchain.pem",
    "key": "certs/privkey.pem"
  },
  "port": 443
}
```

- **Cert renewal**: with `watchTls: true` (default), qpurt watches
  the cert/key's parent directories and hot-swaps the TLS context
  when they change on disk -- no restart needed after
  `certbot renew` or similar.
- **ACME HTTP-01 + HTTP→HTTPS redirect**: when TLS is on, qpurt also
  starts a secondary plain-HTTP listener on `httpPort` (default
  `80`) that serves challenge files from
  `<static>/.well-known/acme-challenge/` (so `certbot --webroot`
  works with zero proxy setup) and 301-redirects everything else to
  HTTPS. Set `httpPort: 0` to disable this listener, or
  `httpsRedirect: false` to serve challenges without redirecting.
- **Minimum TLS version** is pinned to TLSv1.2.
- **`forceHttp: true`** forces plain HTTP even with `tls` configured
  -- useful if `tls` lives in a shared base config block and you
  want to disable it for just one environment.
- If you're in production without TLS and without `forceHttp: true`,
  qpurt logs a warning on startup (in case TLS is meant to be
  terminated upstream by a proxy/CDN, this is expected and the
  warning is just a nudge to double check).

## Rate limiting

Off by default. Enable with:

```json
{ "rateLimit": { "windowMs": 60000, "max": 300 } }
```

This is a simple in-memory, per-IP sliding-window limiter -- no
dependency, single-process only. It's a fit for one instance behind
no load balancer; for multi-instance deployments, put a shared store
(e.g. Redis) in front of qpurt instead. Requests over the limit get
`429` with a `Retry-After` header.

Note this limits request *rate*; `maxConnections` (above) limits
concurrent *sockets* -- they address different things.

## Environments

`server()` resolves an environment name from (in priority order):
`env` on the object passed to `server()`, then `NODE_ENV`, then
`QPURT_ENV`, defaulting to `"development"`. Values starting with
`prod`/`dev` normalize to `"production"`/`"development"`; anything
else (e.g. `"staging"`) passes through as-is.

Config files and `package.json`'s `qpConfig` can carry a `server`
block plus per-environment override blocks, merged shallowly
(`{ ...server, ...envBlock }`):

```json
{
  "server": { "port": 3000, "watch": true },
  "production": { "port": 443, "watch": false, "tls": { "...": "..." } }
}
```

Run with `NODE_ENV=production node start.js` to pick up the
`production` block.

## Graceful shutdown

On `SIGTERM` or `SIGINT`, qpurt stops accepting new connections and
lets in-flight requests finish before exiting -- rather than dying
mid-response when your process manager (Docker/systemd/k8s) redeploys.
If connections haven't drained after 10s, it force-exits.

## API

```js
import { server } from './qpurt.js';

const s = server(configObjectOrPathOrNothing);
await s.start();
```

`server(c)` accepts:
- nothing -- defaults + `package.json` + `qpurt.json` only
- a string -- path to a `.json` config file
- an object -- inline config, merged on top of everything else

`s.start()` starts listening and wires up watchers, TLS renewal, and
graceful shutdown handlers.

## Security

### Reporting a vulnerability

If you find a security issue in qpurt, please report it privately
rather than opening a public issue -- email
`arakilian0@gmail.com` with a description and, if possible,
steps to reproduce. I'll aim to acknowledge within a few days.

### Supported versions

qpurt is a single file. Security fixes are made to the latest
version -- there's no parallel-maintained release branch. Keep your
copy of `qpurt.js` up to date.

### Design principles

- **Zero dependencies.** qpurt only imports Node core
  modules (`fs`, `path`, `url`, `http`, `https`). It never installs
  packages, shells out to `npm`, or touches `node_modules` on its
  own -- there is no dependency supply chain to audit beyond Node
  itself.
- **Fail closed, not open.** Ambiguous or malformed input (bad
  percent-encoding, a path that resolves outside the static root, an
  unreadable TLS file) is rejected with a `400`/`500` rather than
  guessed at.
- **No single request can take the whole server down.** Every known
  failure point (file streaming errors, route handler exceptions,
  malformed URLs, unexpected per-request errors of any kind) is
  caught and turned into an HTTP error response instead of an
  uncaught exception. See [Crash containment](#crash-containment)
  below.

### Built-in protections

#### Path traversal

Static file paths are resolved with `path.resolve()` against the
configured `static` directory and rejected if the resolved path
falls outside it (`safe_resolve()`), blocking `../../etc/passwd`
-style traversal regardless of encoding tricks in the URL.

#### Blocked file patterns

Even for paths that *do* resolve inside `static`, `blockedPatterns`
(configurable) blocks serving:

- dotfiles / dot-directories (`.env`, `.git/*`, `.htpasswd`, ...)
- certificate/key files (`.pem`, `.key`, `.p12`, `.pfx`)
- database dumps (`.sql`, `.sqlite`, `.db`)
- editor/backup leftovers (`.bak`, `.backup`, `.old`, `.swp`)

This is defense in depth, not a substitute for keeping secrets out
of your `static` directory in the first place. One explicit
exception is carved out for ACME HTTP-01 challenge files under
`.well-known/acme-challenge/`, which are dot-prefixed by spec and
must be servable for cert issuance/renewal to work.

You can set `blockedPatterns: []` to disable this, but that's not
recommended.

#### Response headers

A conservative set of security headers is applied to every response
by default (`X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy`), plus
`Strict-Transport-Security` automatically whenever TLS is active.
Customize or disable via `securityHeaders` in your config.

`Content-Security-Policy` is deliberately **not** set by default --
a correct CSP depends on what your specific pages load (inline
scripts, third-party embeds, etc.), and a wrong default is more
likely to break your site than protect it. Add one via
`securityHeaders` once you know your page's actual requirements.

#### Slowloris / slow-connection hardening

Built directly into Node's `http.Server`, no dependency required:
`headersTimeout`, `requestTimeout`, `keepAliveTimeout`,
`maxHeadersCount`, and `maxConnections` are all set from config and
applied on startup. Defaults are conservative (20s to receive
headers, 30s for the full request, 500 concurrent connections).

#### Rate limiting

Off by default (opt in via `rateLimit: { windowMs, max }`). When
enabled, it's a simple in-memory sliding window keyed by remote
address -- requests over the limit get `429` with `Retry-After`.
This is intentionally minimal: it's per-process, so it does **not**
provide meaningful protection in a multi-instance deployment behind
a load balancer -- use a shared store (e.g. Redis) or an
edge/CDN-level rate limiter for that case. It also trusts
`socket.remoteAddress` directly; if qpurt sits behind a reverse
proxy or load balancer, that will be the proxy's address, not the
client's, unless you adapt this yourself.

#### Malformed URL handling

Percent-encoded URLs are decoded with `decodeURIComponent`, which
throws on malformed sequences (e.g. a bare `%`). qpurt catches this
explicitly everywhere it decodes a URL and responds `400` rather
than letting the exception propagate.

#### TLS

- Minimum TLS version is pinned to TLSv1.2 regardless of Node's own
  default, so the floor can't silently drift.
- Cert/key files are read from disk paths you configure; missing or
  unreadable files fail loudly at startup with a clear error rather
  than an opaque `https.createServer` failure.
- With `watchTls: true` (default), qpurt watches the cert/key's
  *parent directories* (not the files directly) so that atomic
  renewal tools like `certbot` -- which typically rename/symlink-swap
  files in rather than editing in place -- are picked up reliably,
  including on Linux where a watch on the file's own inode can be
  lost across such a swap.
- Running in `production` without TLS and without `forceHttp: true`
  logs a startup warning, since unencrypted production traffic is
  usually unintentional. If TLS is genuinely terminated upstream
  (a CDN or load balancer), set `forceHttp: true` to silence it.

#### Crash containment

Three independent layers keep a single bad request from taking the
whole process down:

1. **`file_serve`**: static-file streaming errors are caught; if
   headers are already sent, the response is destroyed rather than
   attempting a second `writeHead` (which would throw
   `ERR_HTTP_HEADERS_SENT`).
2. **`requestHandler`**: wraps every request end-to-end. Any error
   -- including ones from code paths that aren't specifically
   guarded -- is caught, logged, and turned into a `500` (or a
   destroyed socket if headers were already sent).
3. **Process-level `uncaughtException` / `unhandledRejection`
   handlers**: a last resort. If something still escapes the layers
   above, qpurt logs it clearly and exits, rather than continuing to
   run in a potentially corrupted state. Run qpurt under a process
   manager (systemd, pm2, Docker's restart policy, k8s) that
   restarts on exit.

#### Route handler isolation

- A route whose handler file doesn't exist logs an error and
  responds `500` -- it doesn't crash the process.
- A route timeout (`routeTimeout`, default 10s) catches handlers
  that never call `res.end()` and sends a `504` instead of hanging
  the connection indefinitely.
- Handler exceptions (sync or async) are caught and turned into a
  `500` if headers haven't been sent yet.

#### Graceful shutdown

`SIGTERM`/`SIGINT` stop new connections and let in-flight requests
finish (up to a 10s grace period) before exiting, so a redeploy
doesn't cut off in-progress responses mid-stream.

### What qpurt does *not* do

qpurt is a small HTTP server, not a framework. It deliberately does
not include, and you should add yourself if you need them:

- **Authentication / authorization** of any kind. Every route
  function you register is reachable by anyone who can send it a
  request; add your own auth inside the handler (or in front of
  qpurt) as needed.
- **Input validation or sanitization** beyond URL decoding and
  static-path traversal protection. Query params (`req.query`,
  `req.searchParams`) and request bodies are handed to your route
  functions as-is -- validate and sanitize before using them in
  file paths, shell commands, database queries, or HTML output.
- **A default Content-Security-Policy** (see above) -- add one that
  matches your actual page content.
- **CSRF protection**, **CORS handling**, or **session management**
  -- add these in your route functions if your app needs them.
- **Multi-instance rate limiting or distributed state of any kind**
  -- the built-in rate limiter and hot-reload watcher are both
  single-process, in-memory.
- **Client IP resolution behind a proxy** -- `rateLimit` uses
  `socket.remoteAddress` directly; if you're behind a reverse proxy
  or load balancer, adapt this for your setup (e.g. trusted
  `X-Forwarded-For` handling) rather than relying on it as-is.

### Hardening checklist for production

- [ ] `watch: false` -- hot reload leaks module instances from
      Node's import cache; fine for dev, not for a long-running
      production process.
- [ ] TLS configured (`tls: { cert, key }`) or explicitly terminated
      upstream with `forceHttp: true` set to acknowledge it.
- [ ] `rateLimit` configured if you don't already have rate limiting
      upstream (CDN, API gateway, etc.).
- [ ] `securityHeaders` reviewed, and a `Content-Security-Policy`
      added if your app serves HTML with any dynamic or third-party
      content.
- [ ] Auth added inside route functions for anything that shouldn't
      be publicly reachable.
- [ ] Secrets (`.env`, keys, credentials) kept outside the `static`
      directory entirely -- don't rely on `blockedPatterns` alone.
- [ ] Running under a process manager that restarts on exit (systemd,
      pm2, Docker restart policy, k8s), since qpurt intentionally
      exits on an uncaught error rather than limping on.

## License

MIT License

Copyright (c) 2026 Michael Arakilian

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
