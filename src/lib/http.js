import { z } from 'zod';
import { isISODate } from './dates.js';

/** An error whose message is safe to show in the apps (`{ message }`). */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (m) => new HttpError(422, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);

/** Validates `data` with a zod schema; the first problem becomes a readable 422 message. */
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue.path.join('.');
  throw badRequest(field && !issue.message.toLowerCase().includes(field.toLowerCase()) ? `${field}: ${issue.message}` : issue.message);
}

/* Reusable field rules */
export const zDate = z.string().refine(isISODate, 'Use a date like 2026-11-12');
export const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-11');
export const zMobile = z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');
export const zText = (max) => z.string().trim().max(max);
export const zOptText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

/** Express error handler — keeps internal errors out of responses. */
export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON body.' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'Photo is too large (max 5 MB).' });
  if (err?.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'This record already exists (duplicate mobile number or ID).' });
  const status = err?.status ?? err?.statusCode;
  if (status >= 400 && status < 500) return res.status(status).json({ message: status === 404 ? 'Not found' : err.expose ? err.message : 'Bad request' });
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ message: 'Something went wrong on the server. Please try again.' });
}

/** Turns rows into CSV (opens in Excel). */
export function toCsv(rows, columns) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => cell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(','));
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
}
