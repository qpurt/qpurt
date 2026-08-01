import { extname } from 'node:path';

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

function _get_mime_type(filePath) {
    return MIME_TYPES[
      extname(filePath).toLowerCase()
    ] || DEFAULT_MIME;
};

export const DEFAULT_MIME = _DEFAULT_MIME;
export const MIME_TYPES = _MIME_TYPES;
export const get_mime_type = _get_mime_type;