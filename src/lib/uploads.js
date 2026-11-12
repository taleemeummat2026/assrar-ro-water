import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { HttpError } from './http.js';

export const uploadRoot = path.resolve(config.uploadDir);
const entriesDir = path.join(uploadRoot, 'entries');
mkdirSync(entriesDir, { recursive: true });

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/** Delivery photo proof: JPEG/PNG/WebP up to 5 MB, stored in uploads/entries/. */
export const upload = multer({
  storage: multer.diskStorage({
    destination: entriesDir,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${randomBytes(6).toString('hex')}${EXT[file.mimetype] ?? '.jpg'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (EXT[file.mimetype]) cb(null, true);
    else cb(new HttpError(422, 'Photo must be a JPEG, PNG or WebP image.'));
  },
});
