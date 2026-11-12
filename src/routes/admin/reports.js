/**
 * Super Admin → Reports (quotation 4.6). Every report returns JSON, or CSV (opens in Excel) with ?format=csv.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.js';
import { requireAdmin } from '../../lib/auth.js';
import { CHARGED, isScheduled, isPausedOn, summarizeMonth } from '../../lib/billing.js';
import { addDays, addMonths, monthOf, todayISO } from '../../lib/dates.js';
import { badRequest, parse, toCsv, zDate, zMonth } from '../../lib/http.js';
import { duesByCustomer, jarBalances } from '../../services/admin.js';
import { CUSTOMER_SELECT, mapCustomer, mapEntry, mapPayment, mapRequest } from '../../services/data.js';

export const reportsRouter = Router();
reportsRouter.use(requireAdmin('manager', 'accounts'));

const range = z.object({ from: zDate.optional(), to: zDate.optional(), format: z.enum(['json', 'csv']).default('json') });
const span = (f) => {
  const to = f.to ?? todayISO();
  const from = f.from ?? addDays(to, -29);
  if (from > to) throw badRequest('"from" must be before "to".');
  return { from, to };
};

function send(res, name, rows, columns, extra = {}) {
  if (res.req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(toCsv(rows, columns));
  }
  res.json({ ...extra, rows });
}

/** Daily Delivery Report (delivery boy wise). */
reportsRouter.get('/daily-deliveries', async (req, res) => {
  const f = parse(range.extend({ date: zDate.optional() }), req.query);
  const date = f.date ?? todayISO();
  const rows = await db.q(
    `SELECT e.*, c.name AS customer_name, c.area, r.name AS route_name FROM delivery_entries e
       JOIN customers c ON c.id = e.customer_id LEFT JOIN routes r ON r.id = c.route_id
      WHERE e.date = ? ORDER BY e.delivery_boy_name, r.sort_order, c.route_order`,
    [date],
  );
  const list = rows.map((r) => ({ ...mapEntry(r), customerName: r.customer_name, area: r.area, routeName: r.route_name }));
  const byBoy = {};
  for (const e of list) {
    const b = (byBoy[e.deliveryBoyName] ??= { deliveryBoy: e.deliveryBoyName, entries: 0, delivered: 0, extra: 0, notTaken: 0, notAvailable: 0, paused: 0, jars: 0, empties: 0 });
    b.entries++;
    b[{ delivered: 'delivered', extra: 'extra', not_taken: 'notTaken', not_available: 'notAvailable', paused: 'paused' }[e.status]]++;
    b.jars += CHARGED.includes(e.status) ? e.jarsDelivered : 0;
    b.empties += e.emptiesCollected;
  }
  send(
    res,
    `daily-deliveries-${date}`,
    list,
    [
      { label: 'Date', value: 'date' },
      { label: 'Delivery boy', value: 'deliveryBoyName' },
      { label: 'Route', value: 'routeName' },
      { label: 'Customer ID', value: 'customerId' },
      { label: 'Customer', value: 'customerName' },
      { label: 'Area', value: 'area' },
      { label: 'Status', value: 'status' },
      { label: 'Jars delivered', value: 'jarsDelivered' },
      { label: 'Empties collected', value: 'emptiesCollected' },
      { label: 'Time', value: (r) => r.recordedAt },
      { label: 'Remarks', value: 'remarks' },
    ],
    { date, byDeliveryBoy: Object.values(byBoy) },
  );
});

/** Customer-wise Monthly Delivery Report. */
reportsRouter.get('/customer-monthly', async (req, res) => {
  const { month = monthOf(todayISO()) } = parse(z.object({ month: zMonth.optional(), format: z.enum(['json', 'csv']).optional() }), req.query);
  const customers = await db.q(`${CUSTOMER_SELECT} ORDER BY c.seq`);
  const entries = await db.q('SELECT * FROM delivery_entries WHERE date >= ? AND date < ?', [`${month}-01`, `${addMonths(month, 1)}-01`]);
  const byCustomer = new Map();
  for (const e of entries.map(mapEntry)) byCustomer.set(e.customerId, [...(byCustomer.get(e.customerId) ?? []), e]);
  const rows = customers
    .map((c) => ({ customerId: c.id, name: c.name, area: c.area, routeName: c.route_name, active: !!c.active, ...summarizeMonth(month, byCustomer.get(c.id) ?? []) }))
    .filter((r) => r.active || r.totalJars > 0);
  send(
    res,
    `customer-monthly-${month}`,
    rows,
    [
      { label: 'Customer ID', value: 'customerId' },
      { label: 'Customer', value: 'name' },
      { label: 'Area', value: 'area' },
      { label: 'Route', value: 'routeName' },
      { label: 'Jars', value: 'totalJars' },
      { label: 'Amount', value: 'amount' },
      { label: 'Delivered days', value: 'delivered' },
      { label: 'Extra days', value: 'extra' },
      { label: 'Not taken', value: 'notTaken' },
      { label: 'Not available', value: 'notAvailable' },
      { label: 'Paused', value: 'paused' },
      { label: 'Empties collected', value: 'emptiesCollected' },
    ],
    { month },
  );
});

/** Not Taken / Missed Delivery Report: not taken, not available, and scheduled days with no entry at all. */
reportsRouter.get('/missed', async (req, res) => {
  const { from, to } = span(parse(range, req.query));
  const today = todayISO();
  const customers = await db.q(`${CUSTOMER_SELECT} WHERE c.active = 1 ORDER BY c.seq`);
  const entries = (await db.q('SELECT * FROM delivery_entries WHERE date BETWEEN ? AND ?', [from, to])).map(mapEntry);
  const pauses = (await db.q("SELECT * FROM requests WHERE type = 'pause' AND status = 'approved' AND from_date <= ? AND to_date >= ?", [to, from])).map(mapRequest);
  const have = new Map(entries.map((e) => [`${e.customerId}|${e.date}`, e]));
  const rows = [];
  for (const row of customers) {
    const c = mapCustomer(row);
    const reqs = pauses.filter((p) => p.customerId === c.id);
    for (let d = from; d <= to && d < today; d = addDays(d, 1)) {
      const e = have.get(`${c.id}|${d}`);
      if (e && (e.status === 'not_taken' || e.status === 'not_available')) {
        rows.push({ date: d, customerId: c.id, name: c.name, area: c.area, routeName: c.routeName, status: e.status, deliveryBoy: e.deliveryBoyName, remarks: e.remarks ?? '' });
      } else if (!e && isScheduled(c.plan, d) && !isPausedOn(reqs, d)) {
        rows.push({ date: d, customerId: c.id, name: c.name, area: c.area, routeName: c.routeName, status: 'missed (no entry)', deliveryBoy: '', remarks: '' });
      }
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.customerId.localeCompare(b.customerId));
  send(
    res,
    `missed-${from}-to-${to}`,
    rows,
    [
      { label: 'Date', value: 'date' },
      { label: 'Customer ID', value: 'customerId' },
      { label: 'Customer', value: 'name' },
      { label: 'Area', value: 'area' },
      { label: 'Route', value: 'routeName' },
      { label: 'Status', value: 'status' },
      { label: 'Delivery boy', value: 'deliveryBoy' },
      { label: 'Remarks', value: 'remarks' },
    ],
    { from, to },
  );
});

/** Jar Stock & Jar Balance Report. */
reportsRouter.get('/jar-balance', async (_req, res) => {
  const rows = (await jarBalances()).filter((r) => r.active || r.balance !== 0);
  const totals = Object.fromEntries((await db.q('SELECT type, SUM(qty) AS qty FROM jar_stock GROUP BY type')).map((r) => [r.type, Number(r.qty)]));
  const withCustomers = rows.reduce((s, r) => s + Math.max(0, r.balance), 0);
  send(
    res,
    'jar-balance',
    rows,
    [
      { label: 'Customer ID', value: 'customerId' },
      { label: 'Customer', value: 'name' },
      { label: 'Area', value: 'area' },
      { label: 'Jars issued', value: 'jarsIssued' },
      { label: 'Jars with customer', value: 'balance' },
    ],
    {
      stock: {
        purchased: totals.purchase ?? 0,
        damaged: totals.damaged ?? 0,
        lost: totals.lost ?? 0,
        withCustomers,
        atPlant: (totals.purchase ?? 0) - (totals.damaged ?? 0) - (totals.lost ?? 0) - withCustomers,
      },
    },
  );
});

/** Billing & Collection Report. */
reportsRouter.get('/collections', async (req, res) => {
  const { from, to } = span(parse(range, req.query));
  const rows = (await db.q('SELECT p.*, c.name AS customer_name FROM payments p JOIN customers c ON c.id = p.customer_id WHERE p.date BETWEEN ? AND ? ORDER BY p.date, p.recorded_at', [from, to])).map(mapPayment);
  const billed = await db.one(`SELECT COALESCE(SUM(jars_delivered * rate_per_jar), 0) AS amount, COALESCE(SUM(jars_delivered), 0) AS jars FROM delivery_entries WHERE status IN ('delivered','extra') AND date BETWEEN ? AND ?`, [from, to]);
  const cash = rows.filter((p) => p.mode === 'cash').reduce((s, p) => s + p.amount, 0);
  const upi = rows.filter((p) => p.mode === 'upi').reduce((s, p) => s + p.amount, 0);
  const online = rows.filter((p) => p.mode === 'online').reduce((s, p) => s + p.amount, 0);
  send(
    res,
    `collections-${from}-to-${to}`,
    rows,
    [
      { label: 'Date', value: 'date' },
      { label: 'Customer ID', value: 'customerId' },
      { label: 'Customer', value: 'customerName' },
      { label: 'Amount', value: 'amount' },
      { label: 'Mode', value: 'mode' },
      { label: 'Reference', value: 'reference' },
      { label: 'Received by', value: 'recordedBy' },
    ],
    { from, to, billed: { amount: Number(billed.amount), jars: Number(billed.jars) }, collected: { cash, upi, online, total: cash + upi + online } },
  );
});

/** Outstanding Dues Report. */
reportsRouter.get('/outstanding', async (_req, res) => {
  const dues = await duesByCustomer();
  const customers = await db.q('SELECT c.id, c.name, c.mobile, c.area, c.active, r.name AS route_name FROM customers c LEFT JOIN routes r ON r.id = c.route_id ORDER BY c.seq');
  const rows = customers
    .map((c) => ({ customerId: c.id, name: c.name, mobile: c.mobile, area: c.area, routeName: c.route_name, active: !!c.active, dues: dues.get(c.id) ?? 0 }))
    .filter((r) => r.dues > 0)
    .sort((a, b) => b.dues - a.dues);
  send(
    res,
    'outstanding-dues',
    rows,
    [
      { label: 'Customer ID', value: 'customerId' },
      { label: 'Customer', value: 'name' },
      { label: 'Mobile', value: 'mobile' },
      { label: 'Area', value: 'area' },
      { label: 'Route', value: 'routeName' },
      { label: 'Dues', value: 'dues' },
    ],
    { total: rows.reduce((s, r) => s + r.dues, 0) },
  );
});

/** Delivery Boy Performance Report. */
reportsRouter.get('/delivery-boy-performance', async (req, res) => {
  const { from, to } = span(parse(range, req.query));
  const rows = await db.q(
    `SELECT b.id, b.name,
            COUNT(e.id) AS entries,
            COUNT(DISTINCT e.date) AS days,
            SUM(e.status = 'delivered') AS delivered,
            SUM(e.status = 'extra') AS extra,
            SUM(e.status = 'not_taken') AS not_taken,
            SUM(e.status = 'not_available') AS not_available,
            COALESCE(SUM(CASE WHEN e.status IN ('delivered','extra') THEN e.jars_delivered ELSE 0 END), 0) AS jars,
            COALESCE(SUM(e.empties_collected), 0) AS empties
       FROM delivery_boys b LEFT JOIN delivery_entries e ON e.delivery_boy_id = b.id AND e.date BETWEEN ? AND ?
      GROUP BY b.id ORDER BY b.name`,
    [from, to],
  );
  const pay = await db.q(
    `SELECT recorded_by_id AS id, SUM(mode = 'cash') AS cash_count, SUM(CASE WHEN mode = 'cash' THEN amount ELSE 0 END) AS cash,
            SUM(CASE WHEN mode = 'upi' THEN amount ELSE 0 END) AS upi
       FROM payments WHERE recorded_by_type = 'delivery' AND date BETWEEN ? AND ? GROUP BY recorded_by_id`,
    [from, to],
  );
  const payBy = new Map(pay.map((p) => [p.id, p]));
  const list = rows.map((r) => ({
    deliveryBoyId: String(r.id),
    name: r.name,
    days: Number(r.days),
    entries: Number(r.entries),
    delivered: Number(r.delivered ?? 0),
    extra: Number(r.extra ?? 0),
    notTaken: Number(r.not_taken ?? 0),
    notAvailable: Number(r.not_available ?? 0),
    jars: Number(r.jars),
    empties: Number(r.empties),
    cash: Number(payBy.get(r.id)?.cash ?? 0),
    upi: Number(payBy.get(r.id)?.upi ?? 0),
  }));
  send(
    res,
    `delivery-boy-performance-${from}-to-${to}`,
    list,
    [
      { label: 'Delivery boy', value: 'name' },
      { label: 'Working days', value: 'days' },
      { label: 'Entries', value: 'entries' },
      { label: 'Delivered', value: 'delivered' },
      { label: 'Extra', value: 'extra' },
      { label: 'Not taken', value: 'notTaken' },
      { label: 'Not available', value: 'notAvailable' },
      { label: 'Jars', value: 'jars' },
      { label: 'Empties', value: 'empties' },
      { label: 'Cash collected', value: 'cash' },
      { label: 'UPI collected', value: 'upi' },
    ],
    { from, to },
  );
});
