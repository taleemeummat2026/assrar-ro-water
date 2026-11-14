/**
 * Google Play review account — run once:  node db/create-review-account.js
 *
 * Creates, through the normal admin API (same rules as the admin panel):
 *   - route "Play Store review" (only the review customer — never shows in real delivery lists)
 *   - delivery partner "Play Store Review", mobile 9999999999, password 1234
 *   - customer "Google Play Review", mobile 9999999999 (approved, on that route) with ~30 days of history
 * The customer logs in with OTP 1234 because .env has OTP_TEST_NUMBERS=9999999999:1234 (no SMS is sent).
 * Safe to run again: anything that already exists is left as it is.
 * Needs ADMIN_MOBILE / ADMIN_PASSWORD (an owner login) in the environment or ../secrets.env.
 */
import { readFileSync } from 'node:fs';
import supertest from 'supertest';

const MOBILE = '9999999999';
const PASSWORD = '1234';

function ownerLogin() {
  if (process.env.ADMIN_MOBILE && process.env.ADMIN_PASSWORD) return { mobile: process.env.ADMIN_MOBILE, password: process.env.ADMIN_PASSWORD };
  const secrets = readFileSync(new URL('../../secrets.env', import.meta.url), 'utf8');
  const get = (k) => secrets.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
  return { mobile: get('ADMIN_MOBILE'), password: get('ADMIN_PASSWORD') };
}

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { addDays, todayISO } = await import('../src/lib/dates.js');
const api = supertest(createApp());

const ok = (res, what) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${res.body?.message ?? ''}`);
  return res.body;
};

try {
  const login = ok(await api.post('/v1/auth/admin/login').send(ownerLogin()), 'owner login');
  const auth = { Authorization: `Bearer ${login.token}` };

  // 1. Delivery partner
  const boys = ok(await api.get('/v1/admin/delivery-boys').set(auth), 'list delivery boys');
  let boy = boys.find((b) => b.mobile === MOBILE);
  if (!boy) boy = { name: 'Play Store Review', ...ok(await api.post('/v1/admin/delivery-boys').set(auth).send({ name: 'Play Store Review', mobile: MOBILE, password: PASSWORD }), 'add delivery partner') };
  console.log(`delivery partner: ${boy.name} (${MOBILE} / ${PASSWORD})`);

  // 2. Separate route, only for the review customer
  const routes = ok(await api.get('/v1/admin/routes').set(auth), 'list routes');
  let route = routes.find((r) => r.name === 'Play Store review');
  if (!route) route = { name: 'Play Store review', ...ok(await api.post('/v1/admin/routes').set(auth).send({ name: 'Play Store review', areas: ['Balaghat'], deliveryBoyId: Number(boy.id), sortOrder: 999 }), 'add route') };
  console.log(`route: ${route.name}`);

  // 3. Customer with a month of history
  const today = todayISO();
  const start = addDays(today, -35);
  const found = ok(await api.get(`/v1/admin/customers?q=${MOBILE}`).set(auth), 'search customers');
  let customer = (Array.isArray(found) ? found : found.customers ?? found.items ?? []).find((c) => c.mobile === MOBILE);
  if (!customer) {
    customer = ok(
      await api.post('/v1/admin/customers').set(auth).send({
        name: 'Google Play Review',
        mobile: MOBILE,
        address: 'Review address (test account), Balaghat',
        area: 'Balaghat',
        routeId: Number(route.id),
        product: 'jar',
        jarsPerDay: 1,
        ratePerJar: 15,
        schedule: { type: 'daily' },
        startDate: start,
        joinedOn: start,
        deposit: 300,
        jarsIssued: 2,
      }),
      'add customer',
    );
    // A few days of each status so the calendar, history and bill show real-looking data.
    let n = 0;
    for (let d = start; d < today; d = addDays(d, 1)) {
      n += 1;
      const status = n % 9 === 0 ? 'not_taken' : n % 13 === 0 ? 'not_available' : n % 11 === 0 ? 'extra' : 'delivered';
      const jars = status === 'extra' ? 2 : status === 'delivered' ? 1 : 0;
      ok(
        await api.put('/v1/admin/entries').set(auth).send({ customerId: customer.id, date: d, status, jarsDelivered: jars, emptiesCollected: jars, reason: 'Google Play review sample data' }),
        `entry ${d}`,
      );
    }
    console.log(`customer: ${customer.id} with ${n} days of history`);
  } else {
    console.log(`customer: ${customer.id} already exists — left as it is`);
  }
  console.log(`\nCustomer app → mobile ${MOBILE}, OTP ${PASSWORD}  (needs OTP_TEST_NUMBERS=${MOBILE}:${PASSWORD} on the server)`);
  console.log(`Delivery app → mobile ${MOBILE}, password ${PASSWORD}`);
} finally {
  await pool.end();
}
