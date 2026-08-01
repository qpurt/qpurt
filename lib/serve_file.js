import { createReadStream } from 'node:fs';
import { get_mime_type } from './mime_types.js';

export default function (res, filePath) {
  const stream = createReadStream(filePath);
  res.writeHead(200, { 'Content-Type': get_mime_type(filePath) });
  stream.pipe(res);
  stream.on('error', () => {
    res.writeHead(500);
    res.end('Server error');
  });
}