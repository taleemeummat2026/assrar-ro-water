/**
 * Daily backup: every table as SQL in backups/YYYY-MM-DD.sql.gz (restorable with phpMyAdmin → Import,
 * or `gunzip < file.sql.gz | mysql -u USER -p DBNAME`). Runs automatically every day; also   npm run db:backup
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';
import mysql from 'mysql2';
import { config } from '../src/config.js';
import { db, pool } from '../src/db.js';
import { addDays, todayISO } from '../src/lib/dates.js';

export async function backupDatabase({ dir = config.backups.dir, keepDays = config.backups.keepDays } = {}) {
  const today = todayISO();
  const folder = path.resolve(dir);
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${today}.sql.gz`);

  const gzip = createGzip();
  const out = createWriteStream(file);
  gzip.pipe(out);
  const write = (s) => new Promise((resolve) => (gzip.write(s) ? resolve() : gzip.once('drain', resolve)));

  await write(`-- Ashhar RO Water backup ${new Date().toISOString()}\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\nSET time_zone = '+00:00';\n\n`);
  const tables = (await db.q('SHOW TABLES')).map((r) => Object.values(r)[0]);
  for (const table of tables) {
    const [create] = await db.q(`SHOW CREATE TABLE \`${table}\``);
    await write(`DROP TABLE IF EXISTS \`${table}\`;\n${create['Create Table']};\n`);
    const rows = await db.q(`SELECT * FROM \`${table}\``);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const cols = Object.keys(chunk[0]).map((c) => `\`${c}\``).join(', ');
      const values = chunk.map((r) => `(${Object.values(r).map((v) => mysql.escape(v)).join(', ')})`).join(',\n');
      await write(`INSERT INTO \`${table}\` (${cols}) VALUES\n${values};\n`);
    }
    await write('\n');
  }
  await write('SET FOREIGN_KEY_CHECKS = 1;\n');
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    gzip.end();
  });

  // Keep the last `keepDays` days.
  const oldest = addDays(today, -keepDays);
  for (const name of await readdir(folder)) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.sql\.gz$/);
    if (m && m[1] < oldest) await unlink(path.join(folder, name)).catch(() => undefined);
  }
  console.log(`[backup] ${file}`);
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  backupDatabase()
    .then(() => pool.end())
    .catch((e) => {
      console.error('Backup failed:', e.message);
      process.exit(1);
    });
}
