/** Queries used by the Super Admin API: live day view, dues and jar totals. */
import { db } from '../db.js';
import { CHARGED, dayKind, round2 } from '../lib/billing.js';
import { monthOf, todayISO } from '../lib/dates.js';
import { autoMarkPaused, mapCustomer, mapEntry, mapRequest } from './data.js';

const CHARGED_SQL = CHARGED.map((s) => `'${s}'`).join(',');

/** Dues per customer: opening balance + finished months − payments (negative = advance). */
export async function duesByCustomer(today = todayISO(), customerIds = null) {
  const monthStart = `${monthOf(today)}-01`;
  const filter = customerIds ? 'WHERE c.id IN (?)' : '';
  if (customerIds && !customerIds.length) return new Map();
  const rows = await db.q(
    `SELECT c.id, c.opening_balance + COALESCE(b.billed, 0) + COALESCE(ev.billed, 0) - COALESCE(p.paid, 0) AS dues
       FROM customers c
       LEFT JOIN (SELECT customer_id, SUM(jars_delivered * rate_per_jar) AS billed FROM delivery_entries
                   WHERE status IN (${CHARGED_SQL}) AND date < ? GROUP BY customer_id) b ON b.customer_id = c.id
       LEFT JOIN (SELECT customer_id, SUM(jars_delivered * rate_per_jar) AS billed FROM event_orders
                   WHERE status = 'delivered' AND event_date < ? GROUP BY customer_id) ev ON ev.customer_id = c.id
       LEFT JOIN (SELECT customer_id, SUM(amount) AS paid FROM payments GROUP BY customer_id) p ON p.customer_id = c.id
       ${filter}`,
    customerIds ? [monthStart, monthStart, customerIds] : [monthStart, monthStart],
  );
  return new Map(rows.map((r) => [r.id, round2(Number(r.dues))]));
}

/** Jars with each customer: issued + delivered − empties collected. */
export async function jarBalances() {
  const rows = await db.q(
    `SELECT c.id, c.name, c.area, c.active, c.jars_issued,
            c.jars_issued + COALESCE(d.net, 0) + COALESCE(ev.net, 0) AS balance
       FROM customers c
       LEFT JOIN (SELECT customer_id, SUM(CASE WHEN status IN (${CHARGED_SQL}) THEN jars_delivered ELSE 0 END) - SUM(empties_collected) AS net
                    FROM delivery_entries GROUP BY customer_id) d ON d.customer_id = c.id
       LEFT JOIN (SELECT customer_id, SUM(jars_delivered - empties_collected) AS net
                    FROM event_orders WHERE status = 'delivered' GROUP BY customer_id) ev ON ev.customer_id = c.id
      ORDER BY c.seq`,
  );
  return rows.map((r) => ({ customerId: r.id, name: r.name, area: r.area, active: !!r.active, jarsIssued: r.jars_issued, balance: Number(r.balance) }));
}

/**
 * Live view of one day for every active customer: entry or what is missing (pending / missed / off).
 * Opening today's view also auto-marks paused customers, like the delivery app does.
 */
export async function dayView(date, { routeId, deliveryBoyId } = {}) {
  const params = [date];
  let where = 'c.active = 1';
  if (routeId) {
    where += ' AND c.route_id = ?';
    params.push(routeId);
  }
  const rows = await db.q(
    `SELECT c.*, r.name AS route_name, r.delivery_boy_id AS route_boy_id,
            COALESCE(rc.delivery_boy_id, r.delivery_boy_id) AS boy_today, b.name AS boy_name
       FROM customers c
       LEFT JOIN routes r ON r.id = c.route_id
       LEFT JOIN route_covers rc ON rc.route_id = r.id AND rc.date = ?
       LEFT JOIN delivery_boys b ON b.id = COALESCE(rc.delivery_boy_id, r.delivery_boy_id)
      WHERE ${where}
      ORDER BY r.sort_order, r.id, c.route_order, c.seq`,
    params,
  );
  const today = todayISO();
  if (date === today) await autoMarkPaused(rows, date);

  const ids = rows.map((r) => r.id);
  const [entries, pauses] = ids.length
    ? await Promise.all([
        db.q('SELECT * FROM delivery_entries WHERE date = ? AND customer_id IN (?)', [date, ids]),
        db.q("SELECT * FROM requests WHERE type = 'pause' AND status = 'approved' AND from_date <= ? AND to_date >= ? AND customer_id IN (?)", [date, date, ids]),
      ])
    : [[], []];
  const entryBy = new Map(entries.map((e) => [e.customer_id, mapEntry(e)]));
  const pausesBy = new Map();
  for (const p of pauses.map(mapRequest)) pausesBy.set(p.customerId, [...(pausesBy.get(p.customerId) ?? []), p]);

  let list = rows.map((row) => {
    const customer = mapCustomer(row);
    const entry = entryBy.get(row.id);
    const kind = dayKind(date, entry, { plan: customer.plan, active: true, today, requests: pausesBy.get(row.id) ?? [] });
    return {
      customerId: row.id,
      name: row.name,
      mobile: row.mobile,
      area: row.area,
      routeId: row.route_id ? String(row.route_id) : null,
      routeName: row.route_name ?? null,
      deliveryBoyId: row.boy_today ? String(row.boy_today) : null,
      deliveryBoyName: row.boy_name ?? null,
      plan: `${customer.plan.jarsPerDay} × ${customer.plan.product}`,
      kind,
      entry: entry ?? null,
    };
  });
  if (deliveryBoyId) list = list.filter((r) => r.deliveryBoyId === String(deliveryBoyId));

  const counts = { total: 0, delivered: 0, extra: 0, not_taken: 0, not_available: 0, paused: 0, pending: 0, missed: 0, off: 0, jarsDelivered: 0, emptiesCollected: 0 };
  for (const r of list) {
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    if (r.kind !== 'off' && r.kind !== 'inactive' && r.kind !== 'upcoming') counts.total++;
    if (r.entry) {
      counts.jarsDelivered += CHARGED.includes(r.entry.status) ? r.entry.jarsDelivered : 0;
      counts.emptiesCollected += r.entry.emptiesCollected;
    }
  }
  return { date, counts, rows: list };
}
