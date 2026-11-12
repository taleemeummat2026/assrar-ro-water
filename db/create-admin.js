/**
 * Creates (or resets the password of) an admin login.
 *   npm run admin:create -- 9876500000 "StrongPassword" "Ashhar Nawaz" owner
 * Role: owner | manager | accounts (default owner).
 */
import bcrypt from 'bcryptjs';
import { db, pool } from '../src/db.js';

const [mobile, password, name = 'Owner', role = 'owner'] = process.argv.slice(2);

if (!/^\d{10}$/.test(mobile ?? '') || !password || password.length < 6 || !['owner', 'manager', 'accounts'].includes(role)) {
  console.log('Usage: npm run admin:create -- <10-digit mobile> <password, 6+ chars> "<name>" [owner|manager|accounts]');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 10);
await db.q(
  `INSERT INTO admin_users (name, mobile, password_hash, role, active) VALUES (?, ?, ?, ?, 1)
   ON DUPLICATE KEY UPDATE name = VALUES(name), password_hash = VALUES(password_hash), role = VALUES(role), active = 1`,
  [name, mobile, hash, role],
);
console.log(`Admin login ready: ${mobile} (${role}).`);
await pool.end();
