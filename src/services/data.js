/**
 * Reads data from MySQL and shapes it exactly like the apps' `src/api/types.ts`.
 */
import { config } from '../config.js';
import { db } from '../db.js';
import {
  buildBills,
  extraRequestedOn,
  isPausedOn,
  isScheduled,
  jarBalance,
  outstandingDues,
  round2,
} from '../lib/billing.js';
import { fromSqlDateTime, monthOf, toSqlDateTime } from '../lib/dates.js';

export const SYSTEM_NAME = 'Auto (pause request)';

export const CUSTOMER_SELECT = `
  SELECT c.*, r.name AS route_name, r.delivery_boy_id AS route_boy_id
  FROM customers c LEFT JOIN routes r ON r.id = c.route_id`;

/** Drops null / undefined fields so the JSON matches the optional fields in the apps. */
export function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}

export function scheduleOf(row) {
  if (row.schedule_type === 'weekdays') {
    return {
      type: 'weekdays',
      days: String(row.schedule_days ?? '')
        .split(',')
        .filter((d) => d !== '')
        .map(Number),
    };
  }
  return { type: row.schedule_type };
}

export function mapCustomer(r) {
  return compact({
    id: r.id,
    name: r.name,
    mobile: r.mobile,
    address: r.address,
    area: r.area,
    routeId: r.route_id ? String(r.route_id) : '',
    routeName: r.route_name ?? '',
    location: r.lat !== null && r.lng !== null ? { lat: Number(r.lat), lng: Number(r.lng) } : null,
    plan: {
      product: r.product,
      jarsPerDay: r.jars_per_day,
      ratePerJar: Number(r.rate_per_jar),
      schedule: scheduleOf(r),
      startDate: r.start_date,
    },
    deposit: Number(r.deposit),
    jarsIssued: r.jars_issued,
    joinedOn: r.joined_on,
    active: !!r.active,
    deliveryBoyId: r.route_boy_id ? String(r.route_boy_id) : '',
  });
}

export function mapEntry(r) {
  return compact({
    id: String(r.id),
    customerId: r.customer_id,
    date: r.date,
    status: r.status,
    jarsDelivered: r.jars_delivered,
    emptiesCollected: r.empties_collected,
    ratePerJar: Number(r.rate_per_jar),
    remarks: r.remarks,
    photoUrl: r.photo_url && r.photo_url.startsWith('/') ? `${config.publicUrl}${r.photo_url}` : r.photo_url,
    deliveryBoyId: r.delivery_boy_id ? String(r.delivery_boy_id) : 'SYSTEM',
    deliveryBoyName: r.delivery_boy_name,
    recordedAt: fromSqlDateTime(r.recorded_at),
  });
}

export function mapPayment(r) {
  return compact({
    id: String(r.id),
    customerId: r.customer_id,
    customerName: r.customer_name,
    amount: Number(r.amount),
    mode: r.mode,
    reference: r.reference,
    date: r.date,
    recordedAt: fromSqlDateTime(r.recorded_at),
    recordedBy: r.recorded_by_name,
  });
}

export function mapRequest(r) {
  return compact({
    id: String(r.id),
    customerId: r.customer_id,
    type: r.type,
    status: r.status,
    createdAt: fromSqlDateTime(r.created_at),
    date: r.date,
    jars: r.jars,
    fromDate: r.from_date,
    toDate: r.to_date,
    topic: r.topic,
    message: r.message,
    adminNote: r.admin_note,
  });
}

export const EVENT_SELECT = `
  SELECT o.*, c.name AS customer_name, c.mobile AS customer_mobile, c.area AS customer_area,
         b.name AS boy_name, b.mobile AS boy_mobile
    FROM event_orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN delivery_boys b ON b.id = o.delivery_boy_id`;

export function mapEventOrder(r) {
  const jars = r.status === 'delivered' ? r.jars_delivered : r.quantity;
  return compact({
    id: String(r.id),
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerMobile: r.customer_mobile,
    customerArea: r.customer_area,
    eventType: r.event_type,
    eventDate: r.event_date,
    deliveryTime: r.delivery_time,
    product: r.product,
    quantity: r.quantity,
    ratePerJar: Number(r.rate_per_jar),
    amount: round2(jars * Number(r.rate_per_jar)),
    address: r.address,
    contactName: r.contact_name,
    contactMobile: r.contact_mobile,
    notes: r.notes,
    status: r.status,
    deliveryBoyId: r.delivery_boy_id ? String(r.delivery_boy_id) : null,
    deliveryBoyName: r.boy_name,
    deliveryBoyMobile: r.boy_mobile,
    adminNote: r.admin_note,
    jarsDelivered: r.jars_delivered,
    emptiesCollected: r.status === 'delivered' ? r.empties_collected : null,
    deliveredAt: fromSqlDateTime(r.delivered_at),
    deliveredBy: r.delivered_by_name,
    remarks: r.remarks,
    createdBy: r.created_by,
    createdAt: fromSqlDateTime(r.created_at),
  });
}

/** Delivered event orders in the shape billing needs. */
export const eventCharges = (orders) =>
  orders.filter((o) => o.status === 'delivered').map((o) => ({ date: o.eventDate, jars: o.jarsDelivered ?? 0, amount: o.amount, emptiesCollected: o.emptiesCollected ?? 0 }));

export function mapNotification(r) {
  return { id: String(r.id), kind: r.kind, title: r.title, body: r.body, createdAt: fromSqlDateTime(r.created_at), read: r.read_at !== null };
}

/* ---------------- one customer ---------------- */

export const getCustomerRow = (id, exec = db) => exec.one(`${CUSTOMER_SELECT} WHERE c.id = ?`, [id]);

export async function customerEntries(id, exec = db) {
  const rows = await exec.q('SELECT * FROM delivery_entries WHERE customer_id = ? ORDER BY date', [id]);
  return rows.map(mapEntry);
}

export async function customerRequests(id, exec = db) {
  const rows = await exec.q('SELECT * FROM requests WHERE customer_id = ? ORDER BY created_at DESC, id DESC', [id]);
  return rows.map(mapRequest);
}

export async function customerPayments(id, exec = db) {
  const rows = await exec.q('SELECT * FROM payments WHERE customer_id = ? ORDER BY recorded_at DESC, id DESC', [id]);
  return rows.map(mapPayment);
}

/** Everything about one customer's account: entries, bills, dues, jar balance. */
export async function customerAccount(row, today, exec = db) {
  const customer = mapCustomer(row);
  const [entries, requests, payments, eventOrders] = await Promise.all([
    customerEntries(row.id, exec),
    customerRequests(row.id, exec),
    customerPayments(row.id, exec),
    exec.q(`${EVENT_SELECT} WHERE o.customer_id = ? ORDER BY o.event_date DESC, o.id DESC`, [row.id]).then((rows) => rows.map(mapEventOrder)),
  ]);
  const events = eventCharges(eventOrders);
  const totalPaid = round2(payments.reduce((s, p) => s + p.amount, 0));
  const currentMonth = monthOf(today);
  const firstMonth = [entries[0]?.date, ...events.map((e) => e.date)].filter(Boolean).map(monthOf).sort()[0] ?? currentMonth;
  const openingBalance = Number(row.opening_balance ?? 0);
  const bills = buildBills({
    customerId: row.id,
    ratePerJar: customer.plan.ratePerJar,
    firstMonth: firstMonth < currentMonth ? firstMonth : currentMonth,
    currentMonth,
    entries,
    totalPaid,
    openingBalance,
    events,
  });
  return {
    customer,
    entries,
    requests,
    payments,
    eventOrders,
    totalPaid,
    openingBalance,
    bills,
    dues: outstandingDues(bills, totalPaid, openingBalance),
    jarBalance: jarBalance(customer.jarsIssued, entries, events),
    ctx: { plan: customer.plan, active: customer.active, today, requests },
  };
}

/* ---------------- delivery stops ---------------- */

/** Stops for many customers at once (today's list, search). Jar balance and dues come from SQL totals. */
export async function buildStops(rows, date, exec = db) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const monthStart = `${monthOf(date)}-01`;
  const [entries, requests, totals, paid, events] = await Promise.all([
    exec.q('SELECT * FROM delivery_entries WHERE customer_id IN (?) AND date = ?', [ids, date]),
    exec.q(
      `SELECT * FROM requests WHERE customer_id IN (?) AND status = 'approved'
         AND ((type = 'pause' AND from_date <= ? AND to_date >= ?) OR (type = 'extra_jar' AND date = ?))`,
      [ids, date, date, date],
    ),
    exec.q(
      `SELECT customer_id,
              SUM(CASE WHEN status IN ('delivered','extra') THEN jars_delivered ELSE 0 END) - SUM(empties_collected) AS jar_net,
              SUM(CASE WHEN status IN ('delivered','extra') AND date < ? THEN jars_delivered * rate_per_jar ELSE 0 END) AS billed
         FROM delivery_entries WHERE customer_id IN (?) GROUP BY customer_id`,
      [monthStart, ids],
    ),
    exec.q('SELECT customer_id, SUM(amount) AS paid FROM payments WHERE customer_id IN (?) GROUP BY customer_id', [ids]),
    exec.q(
      `SELECT customer_id, SUM(jars_delivered - empties_collected) AS jar_net,
              SUM(CASE WHEN event_date < ? THEN jars_delivered * rate_per_jar ELSE 0 END) AS billed
         FROM event_orders WHERE status = 'delivered' AND customer_id IN (?) GROUP BY customer_id`,
      [monthStart, ids],
    ),
  ]);

  const eventsBy = new Map(events.map((e) => [e.customer_id, e]));
  const entryBy = new Map(entries.map((e) => [e.customer_id, mapEntry(e)]));
  const totalsBy = new Map(totals.map((t) => [t.customer_id, t]));
  const paidBy = new Map(paid.map((p) => [p.customer_id, Number(p.paid)]));
  const requestsBy = new Map();
  for (const r of requests.map(mapRequest)) requestsBy.set(r.customerId, [...(requestsBy.get(r.customerId) ?? []), r]);

  return rows.map((row, i) => {
    const customer = mapCustomer(row);
    const reqs = requestsBy.get(row.id) ?? [];
    const t = totalsBy.get(row.id);
    const ev = eventsBy.get(row.id);
    return {
      customer,
      date,
      sequence: i + 1,
      scheduled: isScheduled(customer.plan, date),
      entry: entryBy.get(row.id) ?? null,
      paused: isPausedOn(reqs, date),
      extraRequested: extraRequestedOn(reqs, date),
      jarBalance: customer.jarsIssued + Number(t?.jar_net ?? 0) + Number(ev?.jar_net ?? 0),
      dues: round2(Number(row.opening_balance ?? 0) + Number(t?.billed ?? 0) + Number(ev?.billed ?? 0) - (paidBy.get(row.id) ?? 0)),
    };
  });
}

/** Routes a delivery boy covers on `date` (his own, minus ones given to someone else, plus covers). */
export function routesForBoy(boyId, date, exec = db) {
  return exec.q(
    `SELECT r.id, r.name FROM routes r
       LEFT JOIN route_covers rc ON rc.route_id = r.id AND rc.date = ?
      WHERE r.active = 1 AND COALESCE(rc.delivery_boy_id, r.delivery_boy_id) = ?
      ORDER BY r.sort_order, r.id`,
    [date, boyId],
  );
}

/** Customers with an approved pause on `date` and no entry get an automatic "Paused" entry. */
export async function autoMarkPaused(rows, date, exec = db) {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const pauses = await exec.q(
    `SELECT DISTINCT customer_id FROM requests
      WHERE customer_id IN (?) AND type = 'pause' AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
    [ids, date, date],
  );
  const paused = new Set(pauses.map((p) => p.customer_id));
  const now = toSqlDateTime();
  for (const row of rows) {
    const customer = mapCustomer(row);
    if (!paused.has(row.id) || !isScheduled(customer.plan, date)) continue;
    await exec.q(
      `INSERT IGNORE INTO delivery_entries
         (customer_id, date, status, jars_delivered, empties_collected, rate_per_jar, delivery_boy_id, delivery_boy_name, recorded_at)
       VALUES (?, ?, 'paused', 0, 0, ?, NULL, ?, ?)`,
      [row.id, date, row.rate_per_jar, SYSTEM_NAME, now],
    );
  }
}

/** Today's list for one delivery boy, in route order. */
export async function todayList(boyId, date, exec = db) {
  const routes = await routesForBoy(boyId, date, exec);
  if (!routes.length) return [];
  const routeIds = routes.map((r) => r.id);
  const rows = await exec.q(
    `${CUSTOMER_SELECT} WHERE c.active = 1 AND c.route_id IN (?) ORDER BY FIELD(c.route_id, ?), c.route_order, c.seq`,
    [routeIds, routeIds],
  );
  await autoMarkPaused(rows, date, exec);
  const withEntry = new Set(
    rows.length ? (await exec.q('SELECT customer_id FROM delivery_entries WHERE customer_id IN (?) AND date = ?', [rows.map((r) => r.id), date])).map((e) => e.customer_id) : [],
  );
  const due = rows.filter((r) => withEntry.has(r.id) || isScheduled(mapCustomer(r).plan, date));
  return buildStops(due, date, exec);
}
