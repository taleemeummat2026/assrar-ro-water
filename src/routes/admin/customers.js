/** Super Admin → Customer management (quotation 4.2). */
import { Router } from 'express';
import { z } from 'zod';
import { db, tx } from '../../db.js';
import { logActivity, notify } from '../../lib/activity.js';
import { requireAdmin } from '../../lib/auth.js';
import { buildMonthDays, summarizeMonth } from '../../lib/billing.js';
import { todayISO } from '../../lib/dates.js';
import { badRequest, notFound, parse, zDate, zMobile, zMonth } from '../../lib/http.js';
import { buildStops, CUSTOMER_SELECT, customerAccount, getCustomerRow, mapCustomer } from '../../services/data.js';

export const customersRouter = Router();
const canEdit = requireAdmin('manager');
const canRead = requireAdmin('manager', 'accounts');

const schedule = z
  .object({ type: z.enum(['daily', 'alternate', 'weekdays']), days: z.array(z.number().int().min(0).max(6)).optional() })
  .refine((s) => s.type !== 'weekdays' || (s.days?.length ?? 0) > 0, 'Pick at least one delivery day');

const fields = {
  name: z.string().trim().min(2, 'Enter the customer name').max(100),
  mobile: zMobile,
  address: z.string().trim().min(3, 'Enter the address').max(255),
  area: z.string().trim().min(1, 'Enter the area').max(80),
  routeId: z.coerce.number().int().positive().nullable(),
  routeName: z.string().trim().max(80), // import: route by name
  routeOrder: z.coerce.number().int().min(0).max(100000),
  lat: z.coerce.number().min(-90).max(90).nullable(),
  lng: z.coerce.number().min(-180).max(180).nullable(),
  product: z.enum(['jar', 'camper']),
  jarsPerDay: z.coerce.number().int().min(1).max(50),
  ratePerJar: z.coerce.number().positive().max(10000),
  schedule,
  startDate: zDate,
  joinedOn: zDate,
  deposit: z.coerce.number().min(0).max(1000000),
  jarsIssued: z.coerce.number().int().min(0).max(1000),
  openingBalance: z.coerce.number().min(-1000000).max(1000000),
  enquiryId: z.coerce.number().int().positive(),
};
const createSchema = z.object(fields).partial().required({ name: true, mobile: true, address: true, area: true });
const updateSchema = z.object({ ...fields, active: z.boolean() }).partial();

async function resolveRoute(input, exec) {
  if (input.routeId) {
    const r = await exec.one('SELECT id FROM routes WHERE id = ?', [input.routeId]);
    if (!r) throw badRequest('Route not found');
    return r.id;
  }
  if (input.routeName) {
    const r = await exec.one('SELECT id FROM routes WHERE name = ?', [input.routeName]);
    if (!r) throw badRequest(`Route "${input.routeName}" not found`);
    return r.id;
  }
  return input.routeId === null ? null : undefined;
}

/** Creates a customer with the next Customer ID (RO-0001, RO-0002 …). */
/** `pending: true` = sign-up from the app: not delivered until the office approves it. */
export async function createCustomer(input, actor, { pending = false } = {}) {
  const today = todayISO();
  return tx(async (t) => {
    const company = await t.one('SELECT * FROM company WHERE id = 1');
    const product = input.product ?? 'jar';
    const jarsPerDay = input.jarsPerDay ?? 1;
    const jarsIssued = input.jarsIssued ?? jarsPerDay + 1;
    const rate = input.ratePerJar ?? Number(product === 'camper' ? company?.camper_rate ?? 20 : company?.jar_rate ?? 15);
    const unitDeposit = Number(product === 'camper' ? company?.camper_deposit ?? 400 : company?.jar_deposit ?? 150);
    const routeId = (await resolveRoute(input, t)) ?? null;
    const sched = input.schedule ?? { type: 'daily' };

    const last = await t.one('SELECT COALESCE(MAX(seq), 0) AS seq FROM customers FOR UPDATE');
    const seq = Number(last.seq) + 1;
    const id = `RO-${String(seq).padStart(4, '0')}`;
    const order = input.routeOrder ?? (routeId ? Number((await t.one('SELECT COALESCE(MAX(route_order), 0) + 1 AS n FROM customers WHERE route_id = ?', [routeId])).n) : 0);

    await t.q(
      `INSERT INTO customers (id, seq, name, mobile, address, area, route_id, route_order, lat, lng, product, jars_per_day,
         rate_per_jar, schedule_type, schedule_days, start_date, deposit, jars_issued, opening_balance, joined_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, seq, input.name, input.mobile, input.address, input.area, routeId, order, input.lat ?? null, input.lng ?? null,
        product, jarsPerDay, rate, sched.type, sched.type === 'weekdays' ? sched.days.join(',') : null,
        input.startDate ?? today, input.deposit ?? jarsIssued * unitDeposit, jarsIssued, input.openingBalance ?? 0, input.joinedOn ?? today,
      ],
    );
    if (input.enquiryId) await t.q("UPDATE enquiries SET status = 'converted', customer_id = ? WHERE id = ?", [id, input.enquiryId]);
    if (pending) {
      await t.q("UPDATE customers SET active = 0, signup_status = 'pending', notes = ? WHERE id = ?", [input.notes || null, id]);
      await notify(id, 'info', 'Request received', `Your Customer ID is ${id}. Our team will call you to confirm your plan, deposit and the day deliveries start.`, t);
    } else {
      await notify(id, 'info', `Welcome to ${company?.name ?? 'our water service'}!`, `Your Customer ID is ${id}. You can see daily deliveries, jar balance and bills in this app.`, t);
    }
    await logActivity(actor, pending ? 'customer.signed_up' : 'customer.created', 'customer', id, { name: input.name, mobile: input.mobile }, t);
    return id;
  });
}

customersRouter.get('/', canRead, async (req, res) => {
  const f = parse(
    z.object({
      q: z.string().trim().max(60).optional(),
      routeId: z.coerce.number().int().optional(),
      active: z.enum(['1', '0', 'all']).default('1'),
      signup: z.enum(['pending', 'rejected']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(500).default(50),
    }),
    req.query,
  );
  const where = [];
  const params = [];
  if (f.signup) {
    where.push('c.signup_status = ?');
    params.push(f.signup);
  } else if (f.active !== 'all') {
    where.push('c.active = ?');
    params.push(Number(f.active));
  }
  if (f.routeId) {
    where.push('c.route_id = ?');
    params.push(f.routeId);
  }
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push('(c.name LIKE ? OR c.id LIKE ? OR c.mobile LIKE ? OR c.area LIKE ? OR c.address LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await db.one(`SELECT COUNT(*) AS n FROM customers c ${whereSql}`, params);
  // On one route, list customers in delivery order.
  const order = f.routeId ? 'c.route_order, c.seq' : 'c.seq';
  const rows = await db.q(`${CUSTOMER_SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, f.limit, (f.page - 1) * f.limit]);
  const stops = await buildStops(rows, todayISO());
  res.json({
    total: Number(total.n),
    page: f.page,
    limit: f.limit,
    items: stops.map((s, i) => ({
      ...s.customer,
      openingBalance: Number(rows[i].opening_balance),
      jarBalance: s.jarBalance,
      dues: s.dues,
      todayStatus: s.entry?.status ?? null,
    })),
  });
});

customersRouter.get('/:id', canRead, async (req, res) => {
  const row = await getCustomerRow(req.params.id);
  if (!row) throw notFound('Customer not found');
  const acc = await customerAccount(row, todayISO());
  res.json({
    customer: acc.customer,
    openingBalance: acc.openingBalance,
    jarBalance: acc.jarBalance,
    dues: acc.dues,
    totalPaid: acc.totalPaid,
    bills: [...acc.bills].reverse(),
    payments: acc.payments,
    requests: acc.requests,
    recentEntries: acc.entries.slice(-60).reverse(),
    eventOrders: acc.eventOrders,
  });
});

customersRouter.get('/:id/calendar', canRead, async (req, res) => {
  const { month } = parse(z.object({ month: zMonth }), req.query);
  const row = await getCustomerRow(req.params.id);
  if (!row) throw notFound('Customer not found');
  const acc = await customerAccount(row, todayISO());
  res.json({ month, days: buildMonthDays(month, acc.entries, acc.ctx), summary: summarizeMonth(month, acc.entries) });
});

customersRouter.get('/:id/bills/:month', canRead, async (req, res) => {
  const { month } = parse(z.object({ month: zMonth }), req.params);
  const row = await getCustomerRow(req.params.id);
  if (!row) throw notFound('Customer not found');
  const acc = await customerAccount(row, todayISO());
  const bill = acc.bills.find((b) => b.month === month);
  if (!bill) throw notFound('No bill for this month.');
  const events = acc.eventOrders.filter((o) => o.status === 'delivered' && o.eventDate.startsWith(month));
  res.json({ ...bill, customer: acc.customer, days: buildMonthDays(month, acc.entries, acc.ctx), events });
});

customersRouter.post('/', canEdit, async (req, res) => {
  const input = parse(createSchema, req.body);
  const id = await createCustomer(input, req.actor);
  res.status(201).json(mapCustomer(await getCustomerRow(id)));
});

/** Bulk import — the web app reads the Excel file and sends its rows here. */
customersRouter.post('/import', canEdit, async (req, res) => {
  const { rows } = parse(z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000) }), req.body);
  const created = [];
  const errors = [];
  for (const [i, raw] of rows.entries()) {
    try {
      created.push(await createCustomer(parse(createSchema, raw), req.actor));
    } catch (e) {
      errors.push({ row: i + 1, message: e.code === 'ER_DUP_ENTRY' ? 'Mobile number already exists' : e.message });
    }
  }
  await logActivity(req.actor, 'customer.imported', 'customer', null, { created: created.length, failed: errors.length });
  res.json({ created, errors });
});

customersRouter.patch('/:id', canEdit, async (req, res) => {
  const input = parse(updateSchema, req.body);
  const row = await getCustomerRow(req.params.id);
  if (!row) throw notFound('Customer not found');

  const cols = {
    name: input.name,
    mobile: input.mobile,
    address: input.address,
    area: input.area,
    route_id: await resolveRoute(input, db),
    route_order: input.routeOrder,
    lat: input.lat,
    lng: input.lng,
    product: input.product,
    jars_per_day: input.jarsPerDay,
    rate_per_jar: input.ratePerJar,
    schedule_type: input.schedule?.type,
    schedule_days: input.schedule ? (input.schedule.type === 'weekdays' ? input.schedule.days.join(',') : null) : undefined,
    start_date: input.startDate,
    joined_on: input.joinedOn,
    deposit: input.deposit,
    jars_issued: input.jarsIssued,
    opening_balance: input.openingBalance,
    active: input.active === undefined ? undefined : input.active ? 1 : 0,
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (set.length) {
    await db.q(`UPDATE customers SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [...set.map(([, v]) => v), row.id]);
    await logActivity(req.actor, input.active === false ? 'customer.deactivated' : 'customer.updated', 'customer', row.id, Object.fromEntries(set));
  }
  res.json(mapCustomer(await getCustomerRow(row.id)));
});

/** Approve an app sign-up: assign route / plan / deposit, and deliveries start. */
customersRouter.post('/:id/approve', canEdit, async (req, res) => {
  const input = parse(
    z
      .object({ routeId: fields.routeId, startDate: fields.startDate, deposit: fields.deposit, jarsIssued: fields.jarsIssued, ratePerJar: fields.ratePerJar, jarsPerDay: fields.jarsPerDay, product: fields.product })
      .partial(),
    req.body,
  );
  const row = await getCustomerRow(req.params.id);
  if (!row) throw notFound('Customer not found');
  if (row.signup_status === 'approved') throw badRequest('This customer is already approved.');
  const today = todayISO();
  const startDate = input.startDate && input.startDate > today ? input.startDate : today;
  await tx(async (t) => {
    await t.q(
      `UPDATE customers SET active = 1, signup_status = 'approved', signup_note = NULL, start_date = ?, joined_on = ?,
         route_id = COALESCE(?, route_id), deposit = COALESCE(?, deposit), jars_issued = COALESCE(?, jars_issued),
         rate_per_jar = COALESCE(?, rate_per_jar), jars_per_day = COALESCE(?, jars_per_day), product = COALESCE(?, product)
       WHERE id = ?`,
      [startDate, today, input.routeId ?? null, input.deposit ?? null, input.jarsIssued ?? null, input.ratePerJar ?? null, input.jarsPerDay ?? null, input.product ?? null, row.id],
    );
    if (input.routeId && !row.route_id) {
      const n = await t.one('SELECT COALESCE(MAX(route_order), 0) + 1 AS n FROM customers WHERE route_id = ?', [input.routeId]);
      await t.q('UPDATE customers SET route_order = ? WHERE id = ?', [n.n, row.id]);
    }
    await notify(row.id, 'info', 'Connection approved!', `Welcome! Deliveries start on ${startDate}. Your Customer ID is ${row.id}.`, t);
    await logActivity(req.actor, 'customer.approved', 'customer', row.id, { startDate, routeId: input.routeId }, t);
  });
  res.json(mapCustomer(await getCustomerRow(row.id)));
});

customersRouter.post('/:id/reject', canEdit, async (req, res) => {
  const { note } = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body);
  const row = await getCustomerRow(req.params.id);
  if (!row) throw notFound('Customer not found');
  if (row.signup_status !== 'pending') throw badRequest('Only new sign-ups waiting for approval can be rejected.');
  await db.q("UPDATE customers SET signup_status = 'rejected', signup_note = ?, active = 0 WHERE id = ?", [note || null, row.id]);
  await notify(row.id, 'info', 'Connection request', note || 'Sorry, we cannot start a connection at your address right now. Please call the office for help.');
  await logActivity(req.actor, 'customer.rejected', 'customer', row.id, { note });
  res.json(mapCustomer(await getCustomerRow(row.id)));
});
