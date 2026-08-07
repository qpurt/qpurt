# QPURT

> Lightweight, zero-dependency Node.js library with a self-healing fallback.

---

# Features

- Pure ESM
- Built on Node.js core modules
- Static file serving
- File-based route handlers
- Environment-aware configuration
- Automatic configuration merging
- HTTPS/TLS support
- Automatic TLS certificate reloading
- HTTP→HTTPS redirects
- ACME challenge support
- Hot module reloading
- Optional self-healing Linux watcher (Chokidar fallback)
- Security headers
- Request timeouts
- Rate limiting
- Graceful shutdown
- MIT Licensed

# Installation

```bash
npm install qpurt
```

Requires Node.js 20+ (recommended).

# Quick Start

```js
import { server } from "qpurt";

server().start();
```

Default directory layout:

```text
project/
├── public/
├── functions/
├── qpurt.json
└── app.js
```

# Configuration

Configuration can come from:

1. Built-in defaults
2. package.json (`qpConfig`)
3. ./qpurt.json or `server('path/to/file.json')`
4. `server({...})`

Later values override earlier ones.

Example:

```json
{
  "server": {
    "port":3000,
    "static":"public",
    "functions":"functions",
    "watch":true
  }
}
```

# Route Functions

```json
{
  "server":{
    "routes":[
      {
        "url":"/api/hello",
        "func":"hello"
      }
    ]
  }
}
```

```js
export default async function(req,res){
    res.end("Hello World");
}
```

# Static Files

Files inside the configured `public` directory are served automatically.

Clean URLs are supported:

```
/about
/about/
/about/index.html
```

# HTTPS

```json
{
  "server":{
    "tls":{
      "cert":"certs/fullchain.pem",
      "key":"certs/privkey.pem"
    }
  }
}
```

Certificates reload automatically when renewed.

# Debugging

## Route returns 500

- Verify the route function exists.
- Ensure it exports a default function.
- Check console output.

## Route returns 504

Your handler never completed the response.

Always call:

```js
res.end();
```

## Watch mode doesn't detect files

Linux automatically attempts to install Chokidar (without modifying package.json). If unavailable, qpurt falls back to `fs.watch`.

## TLS errors

Verify certificate paths and permissions.

# Production Recommendations

- Disable watch mode.
- Enable HTTPS.
- Enable rate limiting.
- Run behind nginx or a CDN if desired.
- Use PM2, Docker, or systemd.

# License

MIT License

Copyright (c) 2026 Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.