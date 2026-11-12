/**
 * End-to-end API tests against a real, temporary MySQL 8.4 (downloaded once by mysql-memory-server).
 *   npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createDB } from 'mysql-memory-server';
import supertest from 'supertest';

let mysqlServer;
let api;
let pool;
let dates;
const tokens = {};
const scratch = mkdtempSync(path.join(tmpdir(), 'ashhar-api-'));

before(async () => {
  mysqlServer = await createDB({ version: '8.4.x', dbName: 'ashhar_test' });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DB_HOST: '127.0.0.1',
    DB_PORT: String(mysqlServer.port),
    DB_USER: mysqlServer.username,
    DB_PASSWORD: '',
    DB_NAME: 'ashhar_test',
    TEST_OTP: '1234',
    PUBLIC_URL: 'https://api.example.com',
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    RAZORPAY_WEBHOOK_SECRET: 'whsec_test',
    PUSH_ENABLED: 'true',
    OTP_TEST_NUMBERS: '9876500002:654321',
    JOBS_ENABLED: 'false',
    UPLOAD_DIR: path.join(scratch, 'uploads'),
    BACKUP_DIR: path.join(scratch, 'backups'),
  });
  const { migrate } = await import('../db/migrate.js');
  await migrate({ log: () => {} });
  const { seedDemo } = await import('../db/seed-demo.js');
  await seedDemo({ log: () => {} });
  const { createApp } = await import('../src/app.js');
  ({ pool } = await import('../src/db.js'));
  dates = await import('../src/lib/dates.js');
  api = supertest(createApp());
});

after(async () => {
  await pool?.end();
  await mysqlServer?.stop();
});

const auth = (role) => ({ Authorization: `Bearer ${tokens[role]}` });
const today = () => dates.todayISO();
const lastMonth = () => dates.addMonths(dates.monthOf(today()), -1);

describe('customer app', () => {
  test('logs in with mobile + OTP', async () => {
    await api.post('/v1/auth/customer/otp').send({ mobile: '9000000000' }).expect(404);
    await api.post('/v1/auth/customer/otp').send({ mobile: '12' }).expect(422);
    await api.post('/v1/auth/customer/otp').send({ mobile: '9876500001' }).expect(200, { sent: true });
    await api.post('/v1/auth/customer/otp').send({ mobile: '9876500001' }).expect(429); // resend too soon
    await api.post('/v1/auth/customer/verify').send({ mobile: '9876500001', otp: '0000' }).expect(401);
    const res = await api.post('/v1/auth/customer/verify').send({ mobile: '9876500001', otp: '1234' }).expect(200);
    assert.equal(res.body.customer.id, 'RO-0001');
    assert.equal(res.body.customer.plan.ratePerJar, 15);
    tokens.customer = res.body.token;
    // Play Store reviewer number with a fixed OTP, no SMS row needed
    await api.post('/v1/auth/customer/verify').send({ mobile: '9876500002', otp: '654321' }).expect(200);
    await api.get('/v1/customer/dashboard').expect(401);
  });

  test('dashboard shows today, jar balance, dues and delivery boy', async () => {
    const { body } = await api.get('/v1/customer/dashboard').set(auth('customer')).expect(200);
    assert.equal(body.today.date, today());
    assert.equal(body.today.kind, 'delivered');
    assert.equal(body.last7Days.length, 7);
    assert.ok(body.jarBalance >= 1);
    assert.ok(body.dues > 0, 'last month is unpaid');
    assert.equal(body.deliveryBoy.name, 'Rahul Kumar');
  });

  test('calendar has a status for every day, with the pause and the extra jar', async () => {
    const m = lastMonth();
    const { body } = await api.get(`/v1/customer/calendar?month=${m}`).set(auth('customer')).expect(200);
    assert.ok(body.days.every((d) => d.entry), 'no blank day');
    assert.deepEqual(body.days.filter((d) => d.kind === 'paused').map((d) => d.date), [`${m}-14`, `${m}-15`, `${m}-16`]);
    assert.equal(body.days.find((d) => d.date === `${m}-09`).entry.jarsDelivered, 2);
    await api.get('/v1/customer/calendar?month=2026-13').set(auth('customer')).expect(422);
  });

  test('bills come from the daily entries; dues = unpaid last month', async () => {
    const bills = (await api.get('/v1/customer/bills').set(auth('customer')).expect(200)).body;
    assert.deepEqual(bills.map((b) => b.status), ['running', 'unpaid', 'paid']);
    const bill = (await api.get(`/v1/customer/bills/${lastMonth()}`).set(auth('customer')).expect(200)).body;
    const fromDays = bill.days.reduce((s, d) => s + (d.entry && ['delivered', 'extra'].includes(d.kind) ? d.entry.jarsDelivered * d.entry.ratePerJar : 0), 0);
    assert.equal(bill.amount, fromDays);
    const dash = (await api.get('/v1/customer/dashboard').set(auth('customer')).expect(200)).body;
    assert.equal(dash.dues, bill.amount);
    const payments = (await api.get('/v1/customer/payments').set(auth('customer')).expect(200)).body;
    assert.ok(payments.length >= 1);
  });

  test('requests are validated and saved as pending', async () => {
    await api.post('/v1/customer/requests').set(auth('customer')).send({ type: 'pause', fromDate: dates.addDays(today(), 3), toDate: dates.addDays(today(), 1) }).expect(422);
    await api.post('/v1/customer/requests').set(auth('customer')).send({ type: 'complaint', topic: 'Billing', message: ' ' }).expect(422);
    await api.post('/v1/customer/requests').set(auth('customer')).send({ type: 'extra_jar', date: dates.addDays(today(), -1), jars: 1 }).expect(422);
    const r = (await api.post('/v1/customer/requests').set(auth('customer')).send({ type: 'extra_jar', date: dates.addDays(today(), 1), jars: 2, message: 'Guests' }).expect(201)).body;
    assert.equal(r.status, 'pending');
    const list = (await api.get('/v1/customer/requests').set(auth('customer')).expect(200)).body;
    assert.equal(list[0].id, r.id);
  });

  test('new connection enquiry needs no login', async () => {
    await api.post('/v1/public/enquiries').send({ name: 'Test Person', mobile: '9811111111', address: 'H.No. 1, Model Town', area: 'Model Town', product: 'jar', jarsPerDay: 1, schedule: 'daily' }).expect(201);
    await api.post('/v1/public/enquiries').send({ name: 'X', mobile: '1', address: '' }).expect(422);
  });
});

describe('delivery app', () => {
  test('logs in with mobile + password', async () => {
    await api.post('/v1/auth/delivery/login').send({ mobile: '9876511111', password: 'nope' }).expect(401);
    const res = await api.post('/v1/auth/delivery/login').send({ mobile: '9876511111', password: '1234' }).expect(200);
    assert.equal(res.body.deliveryBoy.name, 'Rahul Kumar');
    assert.equal(res.body.deliveryBoy.routes.length, 2);
    tokens.delivery = res.body.token;
  });

  test('today’s list: own routes, auto-paused, extra jar asked', async () => {
    const { body } = await api.get('/v1/delivery/today').set(auth('delivery')).expect(200);
    assert.equal(body.date, today());
    assert.ok(body.stops.length > 10);
    assert.ok(body.stops.every((s) => ['Route 1 · Civil Lines', 'Route 2 · Main Market'].includes(s.customer.routeName)));
    const paused = body.stops.find((s) => s.customer.id === 'RO-0006');
    assert.equal(paused.paused, true);
    assert.equal(paused.entry.status, 'paused');
    const extra = body.stops.find((s) => s.customer.id === 'RO-0008');
    assert.equal(extra.extraRequested, 2);
    assert.equal(extra.entry, null);
    assert.deepEqual(body.stops.map((s) => s.sequence), body.stops.map((_, i) => i + 1));
  });

  test('saves an entry once even when the phone retries', async () => {
    const before = (await api.get('/v1/delivery/stops/RO-0008').set(auth('delivery')).expect(200)).body;
    const input = { clientId: 'E-test-0001', customerId: 'RO-0008', date: today(), status: 'extra', jarsDelivered: 4, emptiesCollected: 2, recordedAt: new Date().toISOString() };
    const first = (await api.put('/v1/delivery/entries').set(auth('delivery')).send(input).expect(200)).body;
    const again = (await api.put('/v1/delivery/entries').set(auth('delivery')).send(input).expect(200)).body;
    assert.equal(again.id, first.id);
    assert.equal(first.deliveryBoyName, 'Rahul Kumar');
    const after = (await api.get('/v1/delivery/stops/RO-0008').set(auth('delivery')).expect(200)).body;
    assert.equal(after.jarBalance, before.jarBalance + 2);
    const [[count]] = await pool.query("SELECT COUNT(*) AS n FROM delivery_entries WHERE customer_id = 'RO-0008' AND date = ?", [today()]);
    assert.equal(Number(count.n), 1);
  });

  test('re-visit: not available, then delivered the same day; photo proof upload', async () => {
    const { body } = await api.get('/v1/delivery/today').set(auth('delivery')).expect(200);
    const id = body.stops.find((s) => !s.entry && !s.paused).customer.id;
    await api.put('/v1/delivery/entries').set(auth('delivery')).send({ clientId: 'E-na-0001', customerId: id, date: today(), status: 'not_available', jarsDelivered: 3, emptiesCollected: 1 }).expect(200);
    const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
    const res = await api
      .put('/v1/delivery/entries')
      .set(auth('delivery'))
      .field('data', JSON.stringify({ clientId: 'E-rv-0001', customerId: id, date: today(), status: 'delivered', jarsDelivered: 1, emptiesCollected: 1 }))
      .attach('photo', jpeg, { filename: 'proof.jpg', contentType: 'image/jpeg' })
      .expect(200);
    assert.equal(res.body.status, 'delivered');
    assert.match(res.body.photoUrl, /\/uploads\/entries\/.+\.jpg$/);
    await api.get(new URL(res.body.photoUrl, 'http://x').pathname).expect(200);
  });

  test('rejects old dates and empty deliveries', async () => {
    await api.put('/v1/delivery/entries').set(auth('delivery')).send({ clientId: 'E-old-0001', customerId: 'RO-0002', date: dates.addDays(today(), -5), status: 'delivered', jarsDelivered: 1, emptiesCollected: 1 }).expect(422);
    await api.put('/v1/delivery/entries').set(auth('delivery')).send({ clientId: 'E-zero-001', customerId: 'RO-0002', date: today(), status: 'delivered', jarsDelivered: 0, emptiesCollected: 0 }).expect(422);
  });

  test('collects a payment once and lowers dues', async () => {
    const before = (await api.get('/v1/delivery/stops/RO-0001').set(auth('delivery')).expect(200)).body;
    const pay = { clientId: 'P-test-0001', customerId: 'RO-0001', amount: 100, mode: 'upi', reference: 'UPI123', date: today() };
    const p1 = (await api.post('/v1/delivery/payments').set(auth('delivery')).send(pay).expect(201)).body;
    const p2 = (await api.post('/v1/delivery/payments').set(auth('delivery')).send(pay).expect(200)).body;
    assert.equal(p1.id, p2.id);
    const after = (await api.get('/v1/delivery/stops/RO-0001').set(auth('delivery')).expect(200)).body;
    assert.equal(after.dues, before.dues - 100);
    const today_ = (await api.get('/v1/delivery/today').set(auth('delivery')).expect(200)).body;
    assert.ok(today_.payments.some((p) => p.id === p1.id && p.customerName === 'Ramesh Verma'));
  });

  test('search by ID, number or name', async () => {
    assert.equal((await api.get('/v1/delivery/customers?q=khan').set(auth('delivery')).expect(200)).body[0].customer.name, 'Sana Khan');
    assert.equal((await api.get('/v1/delivery/customers?q=12').set(auth('delivery')).expect(200)).body[0].customer.id, 'RO-0012');
    assert.equal((await api.get('/v1/delivery/customers?q=RO-0025').set(auth('delivery')).expect(200)).body[0].customer.id, 'RO-0025');
    assert.equal((await api.get('/v1/delivery/customers?q=9876500030').set(auth('delivery')).expect(200)).body[0].customer.id, 'RO-0030');
  });

  test('customer sees the delivery boy’s entries as notifications', async () => {
    const list = (await api.get('/v1/customer/notifications').set(auth('customer')).expect(200)).body;
    assert.ok(list.some((n) => n.kind === 'payment' && !n.read));
    await api.post('/v1/customer/notifications/read').set(auth('customer')).expect(200);
    assert.equal((await api.get('/v1/customer/dashboard').set(auth('customer')).expect(200)).body.unreadNotifications, 0);
  });
});

describe('super admin', () => {
  test('logs in and sees the dashboard', async () => {
    await api.post('/v1/auth/admin/login').send({ mobile: '9876500000', password: 'wrong' }).expect(401);
    tokens.admin = (await api.post('/v1/auth/admin/login').send({ mobile: '9876500000', password: 'admin123' }).expect(200)).body.token;
    const d = (await api.get('/v1/admin/dashboard').set(auth('admin')).expect(200)).body;
    assert.equal(d.customers.active, 30);
    assert.ok(d.deliveries.pending > 0);
    assert.ok(d.collections.total >= 100);
    assert.ok(d.outstanding.total > 0);
    assert.ok(d.byDeliveryBoy.length === 2);
    assert.ok(d.notUpdated.length === d.deliveries.pending);
  });

  test('adds a customer with the next Customer ID and default price', async () => {
    const c = (await api.post('/v1/admin/customers').set(auth('admin')).send({ name: 'New Customer', mobile: '9822222222', address: 'H.No. 9, Model Town', area: 'Model Town', routeId: 1, product: 'camper', jarsPerDay: 2 }).expect(201)).body;
    assert.equal(c.id, 'RO-0031');
    assert.equal(c.plan.ratePerJar, 20);
    assert.equal(c.jarsIssued, 3);
    await api.post('/v1/admin/customers').set(auth('admin')).send({ name: 'Dup', mobile: '9822222222', address: 'x x x', area: 'A' }).expect(409);
    const list = (await api.get('/v1/admin/customers?q=New%20Customer').set(auth('admin')).expect(200)).body;
    assert.equal(list.total, 1);
    const imp = (await api.post('/v1/admin/customers/import').set(auth('admin')).send({ rows: [{ name: 'Import One', mobile: '9833333333', address: 'Shop 4, Old City', area: 'Old City', routeName: 'Route 2 · Main Market' }, { name: 'Bad', mobile: '1' }] }).expect(200)).body;
    assert.deepEqual(imp.created, ['RO-0032']);
    assert.equal(imp.errors.length, 1);
  });

  test('approves a pause; it shows on the customer calendar and the delivery list', async () => {
    const pending = (await api.get('/v1/admin/requests?status=pending&type=pause').set(auth('admin')).expect(200)).body;
    const req = pending.find((r) => r.customerId === 'RO-0015');
    await api.post(`/v1/admin/requests/${req.id}/decision`).set(auth('admin')).send({ decision: 'resolved' }).expect(422);
    const done = (await api.post(`/v1/admin/requests/${req.id}/decision`).set(auth('admin')).send({ decision: 'approved', note: 'Have a good trip' }).expect(200)).body;
    assert.equal(done.status, 'approved');
    const detail = (await api.get('/v1/admin/customers/RO-0015').set(auth('admin')).expect(200)).body;
    assert.equal(detail.requests.find((r) => r.id === req.id).adminNote, 'Have a good trip');
  });

  test('resume cuts a running pause short', async () => {
    await api.post('/v1/auth/customer/otp').send({ mobile: '9876500006' }).expect(200);
    tokens.c6 = (await api.post('/v1/auth/customer/verify').send({ mobile: '9876500006', otp: '1234' }).expect(200)).body.token;
    const resume = (await api.post('/v1/customer/requests').set({ Authorization: `Bearer ${tokens.c6}` }).send({ type: 'resume', fromDate: today() }).expect(201)).body;
    await api.post(`/v1/admin/requests/${resume.id}/decision`).set(auth('admin')).send({ decision: 'approved' }).expect(200);
    const stop = (await api.get('/v1/delivery/stops/RO-0006').set(auth('delivery')).expect(200)).body;
    assert.equal(stop.paused, false);
    assert.equal(stop.entry, null); // the automatic "paused" mark for today was removed
  });

  test('corrects an entry with a reason and logs it', async () => {
    const date = dates.addDays(today(), -3);
    await api.put('/v1/admin/entries').set(auth('admin')).send({ customerId: 'RO-0003', date, status: 'delivered', jarsDelivered: 2, emptiesCollected: 1 }).expect(422);
    const e = (await api.put('/v1/admin/entries').set(auth('admin')).send({ customerId: 'RO-0003', date, status: 'delivered', jarsDelivered: 2, emptiesCollected: 1, reason: 'Customer called — got 2 jars' }).expect(200)).body;
    assert.equal(e.jarsDelivered, 2);
    assert.equal(e.deliveryBoyName, 'Demo Owner (office)');
    const log = (await api.get('/v1/admin/activity?entity=entry').set(auth('admin')).expect(200)).body;
    const corrected = log.find((l) => l.action === 'entry.corrected');
    assert.equal(corrected.details.reason, 'Customer called — got 2 jars');
    assert.ok(log.some((l) => l.actorType === 'delivery' && l.action === 'entry.created'));
  });

  test('live day view highlights pending customers', async () => {
    const v = (await api.get('/v1/admin/entries').set(auth('admin')).expect(200)).body;
    assert.equal(v.date, today());
    assert.ok(v.rows.some((r) => r.kind === 'pending'));
    const past = (await api.get(`/v1/admin/entries?date=${dates.addDays(today(), -1)}&kind=pending`).set(auth('admin')).expect(200)).body;
    assert.equal(past.rows.length, 0);
  });

  test('office payment, reminders, broadcast, jar stock, route cover', async () => {
    await api.post('/v1/admin/payments').set(auth('admin')).send({ customerId: 'RO-0010', amount: 200, mode: 'cash' }).expect(201);
    const rem = (await api.post('/v1/admin/reminders/dues').set(auth('admin')).send({ minDues: 1 }).expect(200)).body;
    assert.ok(rem.count > 0);
    assert.match(rem.customers[0].whatsappUrl, /^https:\/\/wa\.me\/91\d{10}\?text=/);
    const sent = (await api.post('/v1/admin/notifications').set(auth('admin')).send({ title: 'Diwali offer', body: '1 jar free on 5 jars', kind: 'offer' }).expect(200)).body;
    assert.equal(sent.sent, 32);
    await api.post('/v1/admin/jar-stock').set(auth('admin')).send({ type: 'purchase', qty: 50 }).expect(201);
    const stock = (await api.get('/v1/admin/jar-stock').set(auth('admin')).expect(200)).body;
    assert.equal(stock.purchased, 170);
    assert.equal(stock.atPlant, stock.purchased - stock.damaged - stock.lost - stock.withCustomers);
    // Imran covers Route 1 tomorrow while Rahul is on leave
    const tomorrow = dates.addDays(today(), 1);
    await api.put('/v1/admin/routes/1/cover').set(auth('admin')).send({ date: tomorrow, deliveryBoyId: 2 }).expect(200);
    const routes = (await api.get('/v1/admin/routes').set(auth('admin')).expect(200)).body;
    assert.equal(routes[0].covers[0].deliveryBoyName, 'Imran Ali');
  });

  test('reports as JSON and CSV', async () => {
    for (const name of ['daily-deliveries', 'customer-monthly', 'missed', 'jar-balance', 'collections', 'outstanding', 'delivery-boy-performance']) {
      const json = (await api.get(`/v1/admin/reports/${name}`).set(auth('admin')).expect(200)).body;
      assert.ok(Array.isArray(json.rows), name);
    }
    const csv = await api.get('/v1/admin/reports/outstanding?format=csv').set(auth('admin')).expect(200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.ok(csv.text.startsWith('﻿Customer ID,Customer,Mobile'));
    const monthly = (await api.get(`/v1/admin/reports/customer-monthly?month=${lastMonth()}`).set(auth('admin')).expect(200)).body;
    assert.ok(monthly.rows.find((r) => r.customerId === 'RO-0001').paused === 3);
  });

  test('roles: accounts cannot add customers or users', async () => {
    await api.post('/v1/admin/users').set(auth('admin')).send({ name: 'Accounts Person', mobile: '9844444444', password: 'secret12', role: 'accounts' }).expect(201);
    const t = (await api.post('/v1/auth/admin/login').send({ mobile: '9844444444', password: 'secret12' }).expect(200)).body.token;
    const h = { Authorization: `Bearer ${t}` };
    await api.get('/v1/admin/payments').set(h).expect(200);
    await api.post('/v1/admin/customers').set(h).send({ name: 'Nope', mobile: '9855555555', address: 'x x x', area: 'A' }).expect(403);
    await api.get('/v1/admin/users').set(h).expect(403);
    await api.put('/v1/admin/company').set(h).send({ name: 'Hacked' }).expect(403);
    await api.get('/v1/admin/users').set(auth('admin')).expect(200); // owner can
    await api.get('/v1/admin/dashboard').set(auth('delivery')).expect(401);
  });

  test('daily backup writes a restorable SQL file', async () => {
    const { backupDatabase } = await import('../db/backup.js');
    const file = await backupDatabase({ dir: process.env.BACKUP_DIR });
    assert.ok(existsSync(file));
    // Restore it into an empty database and compare.
    const { gunzipSync } = await import('node:zlib');
    const { readFileSync } = await import('node:fs');
    const mysql = (await import('mysql2/promise')).default;
    const conn = await mysql.createConnection({ host: '127.0.0.1', port: mysqlServer.port, user: mysqlServer.username, password: '', multipleStatements: true });
    await conn.query('CREATE DATABASE restore_check CHARACTER SET utf8mb4; USE restore_check;');
    await conn.query(gunzipSync(readFileSync(file)).toString('utf8'));
    const [[restored]] = await conn.query('SELECT COUNT(*) AS n FROM delivery_entries');
    const [[original]] = await pool.query('SELECT COUNT(*) AS n FROM delivery_entries');
    assert.equal(Number(restored.n), Number(original.n));
    const [[name]] = await conn.query("SELECT name_hindi FROM company WHERE id = 1");
    assert.equal(name.name_hindi, 'अशहर'); // Hindi text survives
    await conn.end();
  });
});

describe('event orders (wedding / party)', () => {
  const eventDay = () => dates.addDays(today(), 2);
  let orderId;

  test('customer orders jars for an event; past dates are refused', async () => {
    await api.post('/v1/customer/event-orders').set(auth('customer')).send({ eventType: 'Wedding', eventDate: dates.addDays(today(), -1), deliveryTime: '18:30', quantity: 50 }).expect(422);
    await api.post('/v1/customer/event-orders').set(auth('customer')).send({ eventType: 'Wedding', eventDate: eventDay(), deliveryTime: '25:00', quantity: 50 }).expect(422);
    const o = (await api.post('/v1/customer/event-orders').set(auth('customer')).send({ eventType: 'Wedding', eventDate: eventDay(), deliveryTime: '18:30', quantity: 50, notes: 'Near the tent gate' }).expect(201)).body;
    assert.equal(o.status, 'pending');
    assert.equal(o.amount, 750); // 50 × ₹15
    assert.equal(o.address, 'H.No. 17, Civil Lines, near Post Office');
    orderId = o.id;
    const list = (await api.get('/v1/customer/event-orders').set(auth('customer')).expect(200)).body;
    assert.equal(list[0].id, orderId);
    assert.equal((await api.get('/v1/customer/dashboard').set(auth('customer')).expect(200)).body.upcomingEventOrders, 1);
  });

  test('admin assigns it to a delivery boy, who sees it in his app', async () => {
    const pending = (await api.get('/v1/admin/event-orders?status=pending').set(auth('admin')).expect(200)).body;
    assert.ok(pending.some((o) => o.id === orderId));
    assert.ok((await api.get('/v1/admin/dashboard').set(auth('admin')).expect(200)).body.eventOrders.pending >= 1);
    await api.post(`/v1/admin/event-orders/${orderId}/assign`).set(auth('admin')).send({ deliveryBoyId: 999 }).expect(422);
    const a = (await api.post(`/v1/admin/event-orders/${orderId}/assign`).set(auth('admin')).send({ deliveryBoyId: 1, note: 'Bring 2 extra' }).expect(200)).body;
    assert.equal(a.status, 'assigned');
    assert.equal(a.deliveryBoyName, 'Rahul Kumar');
    const mine = (await api.get('/v1/delivery/event-orders').set(auth('delivery')).expect(200)).body;
    assert.equal(mine.find((o) => o.id === orderId).customerName, 'Ramesh Verma');
    const notes = (await api.get('/v1/customer/notifications').set(auth('customer')).expect(200)).body;
    assert.ok(notes.some((n) => n.title === 'Event order confirmed'));
  });

  test('delivered: amount goes on that month’s bill and jars on the jar balance', async () => {
    const before = (await api.get('/v1/delivery/stops/RO-0001').set(auth('delivery')).expect(200)).body;
    const month = dates.monthOf(eventDay());
    const billBefore = (await api.get(`/v1/customer/bills/${month}`).set(auth('customer')).expect(200)).body;
    const done = (await api.post(`/v1/delivery/event-orders/${orderId}/deliver`).set(auth('delivery')).send({ jarsDelivered: 48, emptiesCollected: 0, payment: { amount: 200, mode: 'cash' } }).expect(200)).body;
    assert.equal(done.status, 'delivered');
    assert.equal(done.amount, 720);
    const bill = (await api.get(`/v1/customer/bills/${month}`).set(auth('customer')).expect(200)).body;
    assert.equal(bill.eventAmount, 720);
    assert.equal(bill.amount, billBefore.amount + 720);
    assert.equal(bill.events.length, 1);
    const after = (await api.get('/v1/delivery/stops/RO-0001').set(auth('delivery')).expect(200)).body;
    assert.equal(after.jarBalance, before.jarBalance + 48);
    // empties picked up after the event
    await api.patch(`/v1/admin/event-orders/${orderId}`).set(auth('admin')).send({ emptiesCollected: 48 }).expect(200);
    assert.equal((await api.get('/v1/delivery/stops/RO-0001').set(auth('delivery')).expect(200)).body.jarBalance, before.jarBalance);
  });

  test('customer can cancel a pending order; admin can reject one', async () => {
    const o = (await api.post('/v1/customer/event-orders').set(auth('customer')).send({ eventType: 'Party', eventDate: eventDay(), deliveryTime: '12:00', quantity: 10 }).expect(201)).body;
    assert.equal((await api.post(`/v1/customer/event-orders/${o.id}/cancel`).set(auth('customer')).expect(200)).body.status, 'cancelled');
    await api.post(`/v1/customer/event-orders/${o.id}/cancel`).set(auth('customer')).expect(422);
    const p = (await api.post('/v1/admin/event-orders').set(auth('admin')).send({ customerId: 'RO-0002', eventType: 'Function', eventDate: eventDay(), deliveryTime: '09:00', quantity: 20 }).expect(201)).body;
    assert.equal((await api.post(`/v1/admin/event-orders/${p.id}/reject`).set(auth('admin')).send({ note: 'No stock that day' }).expect(200)).body.status, 'rejected');
  });
});

describe('online payment (Razorpay)', () => {
  let linkStatus = 'created';
  const realFetch = globalThis.fetch;
  const calls = [];

  before(() => {
    // Fake Razorpay API
    globalThis.fetch = async (url, init = {}) => {
      if (!String(url).startsWith('https://api.razorpay.com')) return realFetch(url, init);
      calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
      const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const posts = calls.filter((c) => c.method === 'POST').length;
      if (init.method === 'POST') return json({ id: `plink_TEST${posts}`, short_url: `https://rzp.io/i/test${posts}`, status: 'created' });
      const paid = linkStatus === 'paid';
      return json({ id: String(url).split('/').pop(), status: linkStatus, amount: 42000, amount_paid: paid ? 42000 : 0, payments: paid ? [{ payment_id: 'pay_TEST1', method: 'upi', status: 'captured', amount: 42000 }] : null });
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  test('customer pays dues online; the payment is recorded exactly once', async () => {
    const dash = (await api.get('/v1/customer/dashboard').set(auth('customer')).expect(200)).body;
    assert.equal(dash.onlinePayments, true);
    const start = (await api.post('/v1/customer/online-payments').set(auth('customer')).send({ purpose: 'dues', amount: 420, returnUrl: 'exp://192.168.1.4:8081/--/payment-done' }).expect(201)).body;
    assert.equal(start.url, 'https://rzp.io/i/test1');
    assert.equal(calls[0].body.amount, 42000); // paise
    assert.equal(calls[0].body.callback_url, 'https://api.example.com/v1/public/razorpay/callback');
    assert.equal(calls[0].auth, `Basic ${Buffer.from('rzp_test_key:rzp_test_secret').toString('base64')}`);
    assert.equal((await api.get(`/v1/customer/online-payments/${start.id}`).set(auth('customer')).expect(200)).body.status, 'created');

    linkStatus = 'paid';
    const back = await api.get('/v1/public/razorpay/callback?razorpay_payment_id=pay_TEST1&razorpay_payment_link_id=plink_TEST1&razorpay_payment_link_status=paid&razorpay_signature=x').expect(302);
    assert.equal(back.headers.location, `exp://192.168.1.4:8081/--/payment-done?status=paid&id=${start.id}`);
    await api.get('/v1/public/razorpay/callback?razorpay_payment_link_id=plink_TEST1').expect(302); // again — no double entry
    assert.equal((await api.get(`/v1/customer/online-payments/${start.id}`).set(auth('customer')).expect(200)).body.status, 'paid');
    const pays = (await api.get('/v1/customer/payments').set(auth('customer')).expect(200)).body.filter((p) => p.mode === 'online');
    assert.equal(pays.length, 1);
    assert.equal(pays[0].amount, 420);
    assert.equal(pays[0].reference, 'pay_TEST1');
  });

  test('webhook needs a valid signature and never double-counts', async () => {
    const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_TEST1', status: 'paid' } } } });
    await api.post('/v1/public/razorpay/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', 'bad').send(body).expect(400);
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', 'whsec_test').update(body).digest('hex');
    await api.post('/v1/public/razorpay/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', sig).send(body).expect(200);
    const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM payments WHERE mode = 'online'");
    assert.equal(Number(n.n), 1);
    const totals = (await api.get('/v1/admin/payments').set(auth('admin')).expect(200)).body.totals;
    assert.equal(totals.online, 420);
  });

  test('unknown return addresses are ignored (no open redirect)', async () => {
    linkStatus = 'created';
    const start = (await api.post('/v1/customer/online-payments').set(auth('customer')).send({ purpose: 'dues', amount: 50, returnUrl: 'https://evil.example/steal' }).expect(201)).body;
    const [[row]] = await pool.query('SELECT return_url FROM online_payments WHERE id = ?', [start.id]);
    assert.equal(row.return_url, null);
  });
});

describe('push notifications', () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  before(() => {
    // Fake Expo push service
    globalThis.fetch = async (url, init = {}) => {
      if (!String(url).startsWith('https://exp.host/')) return realFetch(url, init);
      const messages = JSON.parse(init.body);
      sent.push(...messages);
      const data = messages.map((m) => (m.to === 'ExponentPushToken[gone]' ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'r1' }));
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  test('phones register; customer and delivery boy get their own alerts', async () => {
    await api.post('/v1/customer/push-token').set(auth('customer')).send({ token: 'not-a-token' }).expect(422);
    await api.post('/v1/customer/push-token').set(auth('customer')).send({ token: 'ExponentPushToken[cust1]' }).expect(200);
    await api.post('/v1/delivery/push-token').set(auth('delivery')).send({ token: 'ExponentPushToken[boy1]' }).expect(200);

    const o = (await api.post('/v1/admin/event-orders').set(auth('admin')).send({ customerId: 'RO-0001', eventType: 'Wedding', eventDate: dates.addDays(today(), 5), deliveryTime: '19:00', quantity: 30 }).expect(201)).body;
    await api.post(`/v1/admin/event-orders/${o.id}/assign`).set(auth('admin')).send({ deliveryBoyId: 1 }).expect(200);
    await wait(300);
    assert.ok(sent.some((m) => m.to === 'ExponentPushToken[cust1]' && m.title === 'Event order received'));
    assert.ok(sent.some((m) => m.to === 'ExponentPushToken[cust1]' && m.title === 'Event order confirmed'));
    const boyMsg = sent.find((m) => m.to === 'ExponentPushToken[boy1]');
    assert.equal(boyMsg.title, 'New event order');
    assert.equal(boyMsg.data.type, 'event_order');
    assert.ok(!sent.some((m) => m.to === 'ExponentPushToken[boy1]' && m.title.startsWith('Event order received'))); // customers' alerts stay private
  });

  test('offers reach every customer phone; uninstalled phones are removed', async () => {
    await api.post('/v1/customer/push-token').set(auth('customer')).send({ token: 'ExponentPushToken[gone]' }).expect(200);
    await api.post('/v1/admin/notifications').set(auth('admin')).send({ title: 'Holi offer', body: '2 jars free', kind: 'offer' }).expect(200);
    await wait(300);
    assert.ok(sent.some((m) => m.to === 'ExponentPushToken[cust1]' && m.title === 'Holi offer'));
    const [[left]] = await pool.query("SELECT COUNT(*) AS n FROM push_tokens WHERE token = 'ExponentPushToken[gone]'");
    assert.equal(Number(left.n), 0);
    await api.delete('/v1/customer/push-token').set(auth('customer')).send({ token: 'ExponentPushToken[cust1]' }).expect(200);
  });
});
