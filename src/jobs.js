/**
 * Background jobs, checked every 30 minutes while the server runs:
 *  - daily database backup (backups/YYYY-MM-DD.sql.gz, kept BACKUP_KEEP_DAYS days)
 *  - on the 1st of the month: "bill ready" notification to every customer for last month
 *  - cleanup of expired OTPs, old sync receipts and delivery-boy paths older than LOCATION_KEEP_DAYS
 */
import { config } from './config.js';
import { db } from './db.js';
import { notify } from './lib/activity.js';
import { addDays, addMonths, formatMonth, monthOf, todayISO } from './lib/dates.js';
import { backupDatabase } from '../db/backup.js';

async function once(job, period, fn) {
  const done = await db.one('SELECT 1 AS x FROM job_runs WHERE job = ? AND period = ?', [job, period]);
  if (done) return;
  await fn();
  await db.q('INSERT IGNORE INTO job_runs (job, period) VALUES (?, ?)', [job, period]);
}

async function monthlyBillNotices(today) {
  const lastMonth = addMonths(monthOf(today), -1);
  const rows = await db.q(
    `SELECT customer_id, SUM(jars_delivered) AS jars, SUM(jars_delivered * rate_per_jar) AS amount
       FROM delivery_entries WHERE status IN ('delivered','extra') AND date >= ? AND date < ?
      GROUP BY customer_id`,
    [`${lastMonth}-01`, `${monthOf(today)}-01`],
  );
  for (const r of rows) {
    await notify(r.customer_id, 'bill', `Bill for ${formatMonth(lastMonth)} is ready`, `${Number(r.jars)} jars · ₹${Number(r.amount)}. Open Bills to see the day-wise details or download the PDF.`);
  }
  console.log(`[jobs] bill notices sent for ${lastMonth}: ${rows.length}`);
}

export async function runJobs() {
  const today = todayISO();
  try {
    if (config.backups.enabled) await once('backup', today, () => backupDatabase());
    if (today.endsWith('-01')) await once('bill-notices', monthOf(today), () => monthlyBillNotices(today));
    await db.q('DELETE FROM otp_codes WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 DAY');
    await db.q('DELETE FROM sync_receipts WHERE created_at < UTC_TIMESTAMP() - INTERVAL 60 DAY');
    await db.q('DELETE FROM location_points WHERE date < ?', [addDays(today, -config.tracking.keepDays)]);
  } catch (e) {
    console.error('[jobs] failed:', e);
  }
}

export function startJobs() {
  if (!config.jobsEnabled) return;
  setTimeout(runJobs, 10_000).unref();
  setInterval(runJobs, 30 * 60_000).unref();
}
