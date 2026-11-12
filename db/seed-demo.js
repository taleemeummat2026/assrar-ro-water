/**
 * Fills the database with demo data — the same sample customers the apps use in demo mode.
 *   npm run db:seed-demo            (only on an empty database)
 *   npm run db:seed-demo -- --force (WIPES all data first — never on the live database)
 *
 * Logins: admin 9876500000 / admin123 · delivery 9876511111 or 9876522222 / 1234 · customers 98765000xx + OTP (1234 with TEST_OTP=1234).
 */
import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { db, pool, tx } from '../src/db.js';
import { buildBills, extraRequestedOn, isPausedOn, isScheduled } from '../src/lib/billing.js';
import { addDays, addMonths, monthOf, todayISO, toSqlDateTime } from '../src/lib/dates.js';

const TABLES = ['activity_log', 'notifications', 'sync_receipts', 'online_payments', 'event_orders', 'payments', 'delivery_entries', 'requests', 'enquiries', 'otp_codes', 'jar_stock', 'route_covers', 'customers', 'routes', 'delivery_boys', 'job_runs'];

function rng(key) {
  let a = 2166136261;
  for (let i = 0; i < key.length; i++) a = Math.imul(a ^ key.charCodeAt(i), 16777619) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
/** India-time clock time on a date → UTC DATETIME. */
const at = (date, minutes) => toSqlDateTime(new Date(`${date}T00:00:00+05:30`).getTime() + minutes * 60_000);

const ROUTES = [
  { name: 'Route 1 · Civil Lines', areas: ['Civil Lines', 'Station Road'], boy: 0 },
  { name: 'Route 2 · Main Market', areas: ['Main Market', 'Old City'], boy: 0 },
  { name: 'Route 3 · Shastri Nagar', areas: ['Shastri Nagar', 'Gandhi Nagar'], boy: 1 },
];
const BOYS = [
  { name: 'Rahul Kumar', mobile: '9876511111' },
  { name: 'Imran Ali', mobile: '9876522222' },
];
const MON_SAT = { type: 'weekdays', days: [1, 2, 3, 4, 5, 6] };
const MON_FRI = { type: 'weekdays', days: [1, 2, 3, 4, 5] };
const CUSTOMERS = [
  ['Ramesh Verma', 'jar', 1], ['Sana Khan', 'jar', 2], ['Amit Sharma', 'camper', 1], ['Farhan Ahmad', 'jar', 1],
  ['Pooja Gupta', 'jar', 1, { type: 'alternate' }], ['Mohd Arif', 'jar', 2], ['Neha Srivastava', 'jar', 1], ['Vikas Yadav', 'camper', 2],
  ['Shabana Parveen', 'jar', 1], ['Rajesh Mishra', 'jar', 1], ['Anjali Singh', 'jar', 1], ['Imtiyaz Hussain', 'jar', 2],
  ['Agarwal Sweets', 'camper', 4], ['Rukhsar Bano', 'jar', 1], ['Deepak Tiwari', 'jar', 1], ['Kavita Pandey', 'jar', 1, { type: 'alternate' }],
  ['Salman Qureshi', 'jar', 2], ['Chaurasia Medical Store', 'camper', 2, MON_SAT], ['Nazia Siddiqui', 'jar', 1], ['Alok Dubey', 'jar', 1],
  ['Priya Saxena', 'jar', 1], ['Shahid Raza', 'jar', 2], ['Ritu Kesarwani', 'camper', 1], ['Javed Ansari', 'jar', 1],
  ['Maurya Coaching Centre', 'camper', 3, MON_FRI], ['Huma Fatima', 'jar', 1], ['Gaurav Jaiswal', 'jar', 1], ['Tabassum Naaz', 'jar', 1],
  ['Arvind Patel', 'jar', 2], ['Mehtab Alam', 'jar', 1],
];
const PRICE = { jar: { rate: 15, deposit: 150 }, camper: { rate: 20, deposit: 400 } };

/** Two sample event orders: one assigned to the first delivery boy for tomorrow, one waiting for the office. */
export async function insertDemoEvents(t, boyId, today = todayISO()) {
  await t.q(
    `INSERT INTO event_orders (customer_id, event_type, event_date, delivery_time, product, quantity, rate_per_jar, address, contact_name, contact_mobile, notes, status, delivery_boy_id, assigned_at)
     VALUES ('RO-0004', 'Wedding', ?, '17:00', 'jar', 25, 15, 'Shaadi Ghar, Civil Lines, near Post Office', 'Farhan Ahmad', '9876500004', 'Deliver at the back gate', 'assigned', ?, ?),
            ('RO-0008', 'Party / Birthday', ?, '12:00', 'camper', 15, 20, 'H.No. 66, Station Road, opp. Park', NULL, NULL, 'Birthday party on the terrace', 'pending', NULL, NULL)`,
    [addDays(today, 1), boyId, toSqlDateTime(), addDays(today, 3)],
  );
}

export async function seedDemo({ force = false, today = todayISO(), log = console.log } = {}) {
  const existing = await db.one('SELECT COUNT(*) AS n FROM customers');
  if (Number(existing.n) > 0 && !force) throw new Error('The database already has customers. Use --force to wipe it (never on the live database).');

  const firstMonth = addMonths(monthOf(today), -2);
  const yesterday = addDays(today, -1);

  await tx(async (t) => {
    await t.q('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES) await t.q(`DELETE FROM ${table}`);
    await t.q('SET FOREIGN_KEY_CHECKS = 1');

    await t.q(
      `INSERT INTO company (id, name, name_hindi, phone, whatsapp, email, address) VALUES (1, 'Ashhar RO Water', 'अशहर', '+91 98765 43210', '919876543210', 'contact@ashharrowater.in', 'Main Market Road, Your City, Uttar Pradesh')
       ON DUPLICATE KEY UPDATE name = VALUES(name), name_hindi = VALUES(name_hindi), phone = VALUES(phone), whatsapp = VALUES(whatsapp), email = VALUES(email), address = VALUES(address)`,
    );
    await t.q("INSERT IGNORE INTO admin_users (name, mobile, password_hash, role) VALUES ('Demo Owner', '9876500000', ?, 'owner')", [await bcrypt.hash('admin123', 10)]);

    const boyIds = [];
    for (const b of BOYS) boyIds.push((await t.q('INSERT INTO delivery_boys (name, mobile, password_hash) VALUES (?, ?, ?)', [b.name, b.mobile, await bcrypt.hash('1234', 10)])).insertId);
    const routes = [];
    for (const [i, r] of ROUTES.entries()) {
      const res = await t.q('INSERT INTO routes (name, areas, delivery_boy_id, sort_order) VALUES (?, ?, ?, ?)', [r.name, JSON.stringify(r.areas), boyIds[r.boy], i + 1]);
      routes.push({ id: res.insertId, ...r, boyId: boyIds[r.boy], boyName: BOYS[r.boy].name });
    }

    // Customers
    const customers = CUSTOMERS.map(([name, product, jars, schedule], i) => {
      const n = i + 1;
      const route = routes[Math.floor(i / 10)];
      const area = route.areas[Math.floor((i % 10) / 5)];
      const joinedOn = n === 28 || n === 29 ? `${addMonths(firstMonth, 1)}-${pad(8 + n - 28)}` : `2025-${pad((n % 9) + 3)}-${pad((n % 20) + 5)}`;
      return {
        id: `RO-${pad(n, 4)}`, seq: n, name, mobile: `98765000${pad(n)}`,
        address: `${/Store|Sweets|Centre/.test(name) ? 'Shop' : 'H.No.'} ${10 + n * 7}, ${area}, ${n % 3 === 0 ? 'near Masjid' : n % 3 === 1 ? 'near Post Office' : 'opp. Park'}`,
        area, route, routeOrder: (i % 10) + 1, product, jarsPerDay: jars, rate: PRICE[product].rate,
        schedule: schedule ?? { type: 'daily' },
        // History in the system starts on the 1st of `firstMonth` (or when they joined).
        startDate: joinedOn > `${firstMonth}-01` ? joinedOn : `${firstMonth}-01`,
        joinedOn, jarsIssued: jars + 1, deposit: (jars + 1) * PRICE[product].deposit,
      };
    });
    await t.q(
      `INSERT INTO customers (id, seq, name, mobile, address, area, route_id, route_order, product, jars_per_day, rate_per_jar,
         schedule_type, schedule_days, start_date, deposit, jars_issued, joined_on) VALUES ?`,
      [customers.map((c) => [c.id, c.seq, c.name, c.mobile, c.address, c.area, c.route.id, c.routeOrder, c.product, c.jarsPerDay, c.rate, c.schedule.type, c.schedule.days?.join(',') ?? null, c.startDate, c.deposit, c.jarsIssued, c.joinedOn])],
    );

    // Requests that shape the history
    const lastMonth = addMonths(firstMonth, 1);
    const requests = [
      { customerId: 'RO-0001', type: 'complaint', status: 'resolved', createdAt: at(`${firstMonth}-18`, 580), topic: 'Water quality', message: 'Yesterday’s jar had a plastic smell.', adminNote: 'Sorry! The jar was replaced the same day.' },
      { customerId: 'RO-0001', type: 'extra_jar', status: 'approved', createdAt: at(`${lastMonth}-08`, 1140), date: `${lastMonth}-09`, jars: 1, message: 'Guests at home' },
      { customerId: 'RO-0001', type: 'pause', status: 'approved', createdAt: at(`${lastMonth}-13`, 1215), fromDate: `${lastMonth}-14`, toDate: `${lastMonth}-16`, message: 'Going out of town' },
      { customerId: 'RO-0008', type: 'extra_jar', status: 'approved', createdAt: at(yesterday, 1080), date: today, jars: 2, message: 'Function at home' },
      { customerId: 'RO-0006', type: 'pause', status: 'approved', createdAt: at(addDays(today, -2), 1260), fromDate: yesterday, toDate: addDays(today, 2), message: 'Family wedding' },
      { customerId: 'RO-0015', type: 'pause', status: 'pending', createdAt: at(today, 425), fromDate: addDays(today, 3), toDate: addDays(today, 6) },
    ];
    await t.q(
      'INSERT INTO requests (customer_id, type, status, created_at, date, jars, from_date, to_date, topic, message, admin_note) VALUES ?',
      [requests.map((r) => [r.customerId, r.type, r.status, r.createdAt, r.date ?? null, r.jars ?? null, r.fromDate ?? null, r.toDate ?? null, r.topic ?? null, r.message ?? null, r.adminNote ?? null])],
    );
    const reqOf = (id) => requests.filter((r) => r.customerId === id);

    // Daily entries
    const entries = [];
    const make = (c, date, seqNo, owed, force) => {
      const plan = { schedule: c.schedule, startDate: c.startDate };
      if (!isScheduled(plan, date)) return;
      const rand = rng(`${c.id}|${date}`);
      const extraAsked = extraRequestedOn(reqOf(c.id), date);
      const roll = rand();
      let status;
      if (isPausedOn(reqOf(c.id), date)) status = 'paused';
      else if (force) status = force;
      else if (extraAsked > 0) status = 'extra';
      else if (roll < 0.8) status = 'delivered';
      else if (roll < 0.86) status = 'extra';
      else if (roll < 0.94) status = 'not_taken';
      else status = 'not_available';
      let jars = 0;
      let empties = 0;
      if (status === 'delivered') {
        jars = c.jarsPerDay;
        empties = c.jarsPerDay + owed.n;
        owed.n = 0;
      } else if (status === 'extra') {
        jars = c.jarsPerDay + (extraAsked || 1);
        empties = c.jarsPerDay;
        owed.n += jars - c.jarsPerDay;
      }
      const system = status === 'paused';
      entries.push([c.id, date, status, jars, empties, c.rate, status === 'not_available' ? 'Door locked' : null, system ? null : c.route.boyId, system ? 'Auto (pause request)' : c.route.boyName, at(date, 420 + seqNo * 6 + Math.floor(rand() * 5))]);
    };
    for (const route of routes) {
      const list = customers.filter((c) => c.route.id === route.id);
      list.forEach((c, idx) => {
        const owed = { n: 0 };
        for (let d = `${firstMonth}-01`; d <= yesterday; d = addDays(d, 1)) make(c, d, idx + 1, owed);
      });
      // Morning progress: the first ~40% of today's stops are done.
      const due = list.filter((c) => isScheduled({ schedule: c.schedule, startDate: c.startDate }, today));
      const doneCount = Math.floor(due.length * 0.4);
      due.forEach((c, idx) => {
        const paused = isPausedOn(reqOf(c.id), today);
        const extra = extraRequestedOn(reqOf(c.id), today) > 0;
        if (paused || (idx < doneCount && !extra)) make(c, today, idx + 1, { n: 0 }, c.id === 'RO-0001' ? 'delivered' : undefined);
      });
    }
    for (let i = 0; i < entries.length; i += 1000) {
      await t.q(
        'INSERT INTO delivery_entries (customer_id, date, status, jars_delivered, empties_collected, rate_per_jar, remarks, delivery_boy_id, delivery_boy_name, recorded_at) VALUES ?',
        [entries.slice(i, i + 1000)],
      );
    }

    // Payments for finished months
    const thisMonth = monthOf(today);
    const payments = [];
    for (const c of customers) {
      const cEntries = entries
        .filter((e) => e[0] === c.id)
        .map((e) => ({ date: e[1], status: e[2], jarsDelivered: e[3], emptiesCollected: e[4], ratePerJar: e[5] }));
      const bills = buildBills({ customerId: c.id, ratePerJar: c.rate, firstMonth, currentMonth: thisMonth, entries: cEntries, totalPaid: 0 });
      for (const bill of bills) {
        if (bill.status === 'running' || bill.amount === 0) continue;
        const rand = rng(`pay|${c.id}|${bill.month}`);
        const payMonth = addMonths(bill.month, 1);
        const isLatest = payMonth === thisMonth;
        const date = `${payMonth}-${pad(2 + Math.floor(rand() * 7))}`;
        if (date >= today) continue;
        if ((c.id === 'RO-0010' || c.id === 'RO-0020') && !isLatest) continue;
        if (c.id === 'RO-0001' && isLatest) continue;
        const roll = rand();
        if (isLatest && roll > 0.7) continue;
        const amount = isLatest && roll > 0.55 ? Math.round((bill.amount * 0.6) / 10) * 10 : bill.amount;
        const upi = rand() < 0.65;
        const byBoy = rand() < 0.6;
        payments.push([c.id, amount, upi ? 'upi' : 'cash', upi ? `UPI${Math.floor(rand() * 1e9)}` : null, date, byBoy ? 'delivery' : 'admin', byBoy ? c.route.boyId : null, byBoy ? c.route.boyName : 'Office', at(date, 480 + Math.floor(rand() * 600))]);
      }
    }
    if (payments.length) {
      await t.q('INSERT INTO payments (customer_id, amount, mode, reference, date, recorded_by_type, recorded_by_id, recorded_by_name, recorded_at) VALUES ?', [payments]);
    }

    // Notifications
    const notes = [];
    for (const c of customers) {
      notes.push([c.id, 'offer', 'Refer a friend, get 2 jars free', 'Share your Customer ID with a neighbour. When they take a new connection, you get 2 jars free.', at(addDays(today, -4), 600), null]);
      notes.push([c.id, 'bill', 'Monthly bill ready', 'Your bill for last month is ready. Open Bills to see the day-wise details or download the PDF.', at(`${thisMonth}-01`, 360), at(`${thisMonth}-01`, 600)]);
    }
    for (const p of payments) notes.push([p[0], 'payment', 'Payment received', `We received ₹${p[1]} by ${p[2] === 'upi' ? 'UPI' : 'cash'}. Thank you!`, p[8], p[8]]);
    await t.q('INSERT INTO notifications (customer_id, kind, title, body, created_at, read_at) VALUES ?', [notes]);

    await t.q("INSERT INTO jar_stock (type, qty, note, date) VALUES ('purchase', 120, 'Opening stock', ?), ('damaged', 3, 'Cracked jars', ?)", [`${firstMonth}-01`, addDays(today, -10)]);
    await t.q(
      "INSERT INTO enquiries (name, mobile, address, area, product, jars_per_day, schedule, message, source) VALUES ('Sunita Rao', '9123456780', 'H.No. 5, Model Town', 'Model Town', 'jar', 2, 'daily', 'Please call after 5 PM', 'website')",
    );
    await insertDemoEvents(t, boyIds[0], today);
    log(`Demo data: ${customers.length} customers, ${entries.length} entries, ${payments.length} payments (history from ${firstMonth}-01).`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDemo({ force: process.argv.includes('--force') })
    .then(() => pool.end())
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
