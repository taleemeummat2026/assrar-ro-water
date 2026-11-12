/**
 * Dates are plain strings: 'YYYY-MM-DD' (business day in India time) and 'YYYY-MM' for months.
 * Same helpers as the apps' src/lib/date.ts.
 */
import { config } from '../config.js';

const DAY_MS = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Today's date in the business time zone (Asia/Kolkata by default). */
export function todayISO(now = new Date()) {
  return dayFormatter.format(now);
}

const toUTC = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUTC = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export const addDays = (date, n) => fromUTC(toUTC(date) + n * DAY_MS);
export const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
export const weekday = (date) => new Date(toUTC(date)).getUTCDay(); // 0 = Sunday
export const monthOf = (date) => date.slice(0, 7);

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

export function monthRange(from, to) {
  const out = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export const monthDates = (month) => Array.from({ length: daysInMonth(month) }, (_, i) => `${month}-${pad(i + 1)}`);

export function formatMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toUTC(s));

/** ISO timestamp → MySQL DATETIME(3) in UTC. */
export function toSqlDateTime(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return toSqlDateTime(new Date());
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

/** MySQL DATETIME (UTC) → ISO timestamp. */
export function fromSqlDateTime(value) {
  if (!value) return null;
  return `${String(value).replace(' ', 'T')}${String(value).includes('.') ? '' : '.000'}Z`;
}
