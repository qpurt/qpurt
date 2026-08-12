# Security Policy

## Reporting a vulnerability

If you find a security issue in qpurt, please report it privately
rather than opening a public issue -- email
`arakilian0@gmail.com` with a description and, if possible,
steps to reproduce. I'll aim to acknowledge within a few days.

## Supported versions

qpurt is a single file. Security fixes are made to the latest
version -- there's no parallel-maintained release branch. Keep your
copy of `qpurt.js` up to date.

## Design principles

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

## Built-in protections

### Path traversal

Static file paths are resolved with `path.resolve()` against the
configured `static` directory and rejected if the resolved path
falls outside it (`safe_resolve()`), blocking `../../etc/passwd`
-style traversal regardless of encoding tricks in the URL.

### Blocked file patterns

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

### Response headers

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

### Slowloris / slow-connection hardening

Built directly into Node's `http.Server`, no dependency required:
`headersTimeout`, `requestTimeout`, `keepAliveTimeout`,
`maxHeadersCount`, and `maxConnections` are all set from config and
applied on startup. Defaults are conservative (20s to receive
headers, 30s for the full request, 500 concurrent connections).

### Rate limiting

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

### Malformed URL handling

Percent-encoded URLs are decoded with `decodeURIComponent`, which
throws on malformed sequences (e.g. a bare `%`). qpurt catches this
explicitly everywhere it decodes a URL and responds `400` rather
than letting the exception propagate.

### TLS

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

### Crash containment

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

### Route handler isolation

- A route whose handler file doesn't exist logs an error and
  responds `500` -- it doesn't crash the process.
- A route timeout (`routeTimeout`, default 10s) catches handlers
  that never call `res.end()` and sends a `504` instead of hanging
  the connection indefinitely.
- Handler exceptions (sync or async) are caught and turned into a
  `500` if headers haven't been sent yet.

### Graceful shutdown

`SIGTERM`/`SIGINT` stop new connections and let in-flight requests
finish (up to a 10s grace period) before exiting, so a redeploy
doesn't cut off in-progress responses mid-stream.

## What qpurt does *not* do

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

## Hardening checklist for production

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
