/**
 * Removes ALL customers, deliveries, payments, routes, delivery boys … and the demo admin login (9876500000),
 * so the live system starts clean. Keeps the tables, the company profile and your own admin logins.
 *   npm run db:clear-demo -- --yes
 */
import { db, pool, tx } from '../src/db.js';

// push_tokens too: Customer IDs start again at RO-0001, and an old phone's token must not get the new customer's alerts.
const TABLES = ['push_tokens', 'activity_log', 'notifications', 'sync_receipts', 'online_payments', 'event_orders', 'payments', 'delivery_entries', 'requests', 'enquiries', 'otp_codes', 'jar_stock', 'route_covers', 'location_points', 'delivery_locations', 'customers', 'routes', 'delivery_boys', 'job_runs'];

if (!process.argv.includes('--yes')) {
  console.log('This deletes every customer, delivery entry, payment, route and delivery boy.');
  console.log('Run again with --yes to confirm:   npm run db:clear-demo -- --yes');
  process.exit(1);
}

await tx(async (t) => {
  await t.q('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of TABLES) await t.q(`DELETE FROM ${table}`);
  await t.q('SET FOREIGN_KEY_CHECKS = 1');
  await t.q("DELETE FROM admin_users WHERE mobile = '9876500000' AND name = 'Demo Owner'");
});
const admins = await db.one('SELECT COUNT(*) AS n FROM admin_users');
console.log('Demo data removed.');
if (Number(admins.n) === 0) console.log('No admin login left — create yours:  npm run admin:create -- <mobile> <password> "<name>"');
await pool.end();
