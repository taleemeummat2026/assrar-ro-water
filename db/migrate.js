/**
 * Creates / updates the database tables.   npm run db:migrate
 *
 * Also adds the company row and, when ADMIN_MOBILE and ADMIN_PASSWORD are set in .env, the first Owner login.
 * Safe to run again after every update.
 */
import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';

export async function migrate({ log = console.log } = {}) {
  const { host, port, user, password, database } = config.db;
  const conn = await mysql.createConnection({ host, port, user, password, multipleStatements: true, charset: 'utf8mb4' });
  try {
    try {
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } catch {
      log('Could not create the database (normal on shared hosting) — using the existing one.');
    }
    await conn.query(`USE \`${database}\``);
    await conn.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    // Upgrades for databases created by an earlier version (safe to repeat).
    await conn.query("ALTER TABLE payments MODIFY mode ENUM('cash', 'upi', 'online') NOT NULL");
    await conn.query("ALTER TABLE payments MODIFY recorded_by_type ENUM('admin', 'delivery', 'online') NOT NULL");
    // New columns (works on MySQL and MariaDB — neither supports the same "ADD COLUMN IF NOT EXISTS").
    const addColumn = async (table, column, definition) => {
      const [[c]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?', [database, table, column]);
      if (!Number(c.n)) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${column} ${definition}`);
    };
    await addColumn('customers', 'notes', 'VARCHAR(500) NULL');
    await addColumn('customers', 'signup_status', "ENUM('approved', 'pending', 'rejected') NOT NULL DEFAULT 'approved'");
    await addColumn('customers', 'signup_note', 'VARCHAR(300) NULL');
    await addColumn('online_payments', 'order_id', 'VARCHAR(40) NULL UNIQUE');
    log(`Tables ready in database "${database}".`);

    const [[company]] = await conn.query('SELECT id FROM company WHERE id = 1');
    if (!company) {
      await conn.query('INSERT INTO company (id, name, name_hindi, phone, whatsapp, email, address) VALUES (1, ?, ?, ?, ?, ?, ?)', [
        process.env.COMPANY_NAME ?? 'Ashhar RO Water',
        process.env.COMPANY_NAME_HINDI ?? 'अशहर',
        process.env.COMPANY_PHONE ?? '',
        process.env.COMPANY_WHATSAPP ?? '',
        process.env.COMPANY_EMAIL ?? '',
        process.env.COMPANY_ADDRESS ?? '',
      ]);
      log('Company profile created (edit it from the admin panel).');
    }

    const [[admins]] = await conn.query('SELECT COUNT(*) AS n FROM admin_users');
    if (Number(admins.n) === 0) {
      const mobile = process.env.ADMIN_MOBILE;
      const pass = process.env.ADMIN_PASSWORD;
      if (mobile && pass) {
        await conn.query("INSERT INTO admin_users (name, mobile, password_hash, role) VALUES (?, ?, ?, 'owner')", [process.env.ADMIN_NAME ?? 'Owner', mobile, await bcrypt.hash(pass, 10)]);
        log(`Owner login created for ${mobile}. Remove ADMIN_PASSWORD from .env now.`);
      } else {
        log('No admin user yet. Create one with:  npm run admin:create -- <mobile> <password> "<name>"');
      }
    }
  } finally {
    await conn.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('Migration failed:', e.message);
      process.exit(1);
    });
}
