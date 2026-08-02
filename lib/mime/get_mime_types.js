import { extname } from 'node:path';
import { MIME_TYPES, DEFAULT_MIME } from './mime_types.js'; 

export default function (filePath) {
    return MIME_TYPES[
      extname(filePath).toLowerCase()
    ] || DEFAULT_MIME;
};
