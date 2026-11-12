/** Super Admin → routes, delivery boys, daily monitoring, requests, payments, enquiries, notifications, jars. */
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { db, tx } from '../../db.js';
import { logActivity, notify, notifyDeliveryBoy } from '../../lib/activity.js';
import { pushTo } from '../../lib/push.js';
import { requireAdmin } from '../../lib/auth.js';
import { addDays, fromSqlDateTime, todayISO, toSqlDateTime } from '../../lib/dates.js';
import { badRequest, notFound, parse, zDate, zMobile } from '../../lib/http.js';
import { sendSms } from '../../lib/sms.js';
import { dayView, duesByCustomer, jarBalances } from '../../services/admin.js';
import { getCustomerRow, mapEntry, mapPayment, mapRequest } from '../../services/data.js';

export const operationsRouter = Router();
const manager = requireAdmin('manager');
const accounts = requireAdmin('manager', 'accounts');

const parseAreas = (raw) => {
  try {
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

/* ---------------- Routes & areas ---------------- */

operationsRouter.get('/routes', accounts, async (_req, res) => {
  const rows = await db.q(
    `SELECT r.*, b.name AS boy_name, (SELECT COUNT(*) FROM customers c WHERE c.route_id = r.id AND c.active = 1) AS customers
       FROM routes r LEFT JOIN delivery_boys b ON b.id = r.delivery_boy_id ORDER BY r.sort_order, r.id`,
  );
  const covers = await db.q('SELECT rc.*, b.name AS boy_name FROM route_covers rc JOIN delivery_boys b ON b.id = rc.delivery_boy_id WHERE rc.date >= ? ORDER BY rc.date', [todayISO()]);
  res.json(
    rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      areas: parseAreas(r.areas),
      deliveryBoyId: r.delivery_boy_id ? String(r.delivery_boy_id) : null,
      deliveryBoyName: r.boy_name ?? null,
      sortOrder: r.sort_order,
      active: !!r.active,
      customers: Number(r.customers),
      covers: covers.filter((c) => c.route_id === r.id).map((c) => ({ date: c.date, deliveryBoyId: String(c.delivery_boy_id), deliveryBoyName: c.boy_name })),
    })),
  );
});

const routeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  areas: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  deliveryBoyId: z.coerce.number().int().positive().nullable().optional(),
  sortOrder: z.coerce.number().int().default(0),
  active: z.boolean().optional(),
});

operationsRouter.post('/routes', manager, async (req, res) => {
  const input = parse(routeSchema, req.body);
  const r = await db.q('INSERT INTO routes (name, areas, delivery_boy_id, sort_order) VALUES (?, ?, ?, ?)', [input.name, JSON.stringify(input.areas), input.deliveryBoyId ?? null, input.sortOrder]);
  await logActivity(req.actor, 'route.created', 'route', String(r.insertId), input);
  res.status(201).json({ id: String(r.insertId) });
});

operationsRouter.patch('/routes/:id', manager, async (req, res) => {
  const input = parse(routeSchema.partial(), req.body);
  const cols = {
    name: input.name,
    areas: input.areas ? JSON.stringify(input.areas) : undefined,
    delivery_boy_id: input.deliveryBoyId,
    sort_order: input.sortOrder,
    active: input.active === undefined ? undefined : input.active ? 1 : 0,
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (!set.length) return res.json({ ok: true });
  const r = await db.q(`UPDATE routes SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [...set.map(([, v]) => v), req.params.id]);
  if (!r.affectedRows) throw notFound('Route not found');
  await logActivity(req.actor, 'route.updated', 'route', req.params.id, input);
  res.json({ ok: true });
});

/** Delivery order of customers on a route. */
operationsRouter.put('/routes/:id/order', manager, async (req, res) => {
  const { customerIds } = parse(z.object({ customerIds: z.array(z.string()).min(1).max(2000) }), req.body);
  await tx(async (t) => {
    for (const [i, id] of customerIds.entries()) await t.q('UPDATE customers SET route_order = ? WHERE id = ? AND route_id = ?', [i + 1, id, req.params.id]);
  });
  await logActivity(req.actor, 'route.reordered', 'route', req.params.id, { count: customerIds.length });
  res.json({ ok: true });
});

/** Re-assign a route for one day when its delivery boy is on leave. */
operationsRouter.put('/routes/:id/cover', manager, async (req, res) => {
  const { date, deliveryBoyId } = parse(z.object({ date: zDate, deliveryBoyId: z.coerce.number().int().positive() }), req.body);
  await db.q('INSERT INTO route_covers (route_id, date, delivery_boy_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE delivery_boy_id = VALUES(delivery_boy_id)', [req.params.id, date, deliveryBoyId]);
  const route = await db.one('SELECT name FROM routes WHERE id = ?', [req.params.id]);
  notifyDeliveryBoy(deliveryBoyId, 'Extra route for you', `Please also deliver ${route?.name ?? 'a route'} on ${date}. It will show in your list that day.`, { type: 'route_cover', date });
  await logActivity(req.actor, 'route.covered', 'route', req.params.id, { date, deliveryBoyId });
  res.json({ ok: true });
});

operationsRouter.delete('/routes/:id/cover/:date', manager, async (req, res) => {
  await db.q('DELETE FROM route_covers WHERE route_id = ? AND date = ?', [req.params.id, req.params.date]);
  await logActivity(req.actor, 'route.cover_removed', 'route', req.params.id, { date: req.params.date });
  res.json({ ok: true });
});

/* ---------------- Delivery boys ---------------- */

operationsRouter.get('/delivery-boys', accounts, async (_req, res) => {
  const rows = await db.q('SELECT id, name, mobile, active, created_at FROM delivery_boys ORDER BY active DESC, name');
  const routes = await db.q('SELECT id, name, delivery_boy_id FROM routes WHERE active = 1');
  res.json(
    rows.map((b) => ({
      id: String(b.id),
      name: b.name,
      mobile: b.mobile,
      active: !!b.active,
      createdAt: fromSqlDateTime(b.created_at),
      routes: routes.filter((r) => r.delivery_boy_id === b.id).map((r) => ({ id: String(r.id), name: r.name })),
    })),
  );
});

operationsRouter.post('/delivery-boys', manager, async (req, res) => {
  const input = parse(z.object({ name: z.string().trim().min(2).max(80), mobile: zMobile, password: z.string().min(4, 'Password must be at least 4 characters').max(64) }), req.body);
  const r = await db.q('INSERT INTO delivery_boys (name, mobile, password_hash) VALUES (?, ?, ?)', [input.name, input.mobile, await bcrypt.hash(input.password, 10)]);
  await logActivity(req.actor, 'delivery_boy.created', 'delivery_boy', String(r.insertId), { name: input.name, mobile: input.mobile });
  res.status(201).json({ id: String(r.insertId) });
});

operationsRouter.patch('/delivery-boys/:id', manager, async (req, res) => {
  const input = parse(z.object({ name: z.string().trim().min(2).max(80), mobile: zMobile, password: z.string().min(4).max(64), active: z.boolean() }).partial(), req.body);
  const cols = {
    name: input.name,
    mobile: input.mobile,
    password_hash: input.password ? await bcrypt.hash(input.password, 10) : undefined,
    active: input.active === undefined ? undefined : input.active ? 1 : 0,
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (!set.length) return res.json({ ok: true });
  const r = await db.q(`UPDATE delivery_boys SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [...set.map(([, v]) => v), req.params.id]);
  if (!r.affectedRows) throw notFound('Delivery boy not found');
  await logActivity(req.actor, 'delivery_boy.updated', 'delivery_boy', req.params.id, { ...input, password: input.password ? '(changed)' : undefined });
  res.json({ ok: true });
});

/* ---------------- Daily delivery monitoring ---------------- */

/** Live status of every customer for a day (pending / missed highlighted). */
operationsRouter.get('/entries', accounts, async (req, res) => {
  const f = parse(z.object({ date: zDate.optional(), routeId: z.coerce.number().int().optional(), deliveryBoyId: z.coerce.number().int().optional(), kind: z.string().optional() }), req.query);
  const view = await dayView(f.date ?? todayISO(), f);
  res.json(f.kind ? { ...view, rows: view.rows.filter((r) => r.kind === f.kind) } : view);
});

/** Edit / correct an entry with a reason (logged). */
operationsRouter.put('/entries', manager, async (req, res) => {
  const input = parse(
    z.object({
      customerId: z.string().trim().min(1),
      date: zDate,
      status: z.enum(['delivered', 'extra', 'not_taken', 'not_available', 'paused']),
      jarsDelivered: z.coerce.number().int().min(0).max(100),
      emptiesCollected: z.coerce.number().int().min(0).max(100),
      remarks: z.string().trim().max(300).optional(),
      reason: z.string().trim().min(3, 'Write why this entry is being corrected').max(300),
    }),
    req.body,
  );
  if (input.date > todayISO()) throw badRequest('You cannot enter a future date.');
  const row = await getCustomerRow(input.customerId);
  if (!row) throw notFound('Customer not found');
  const charged = input.status === 'delivered' || input.status === 'extra';
  if (charged && input.jarsDelivered < 1) throw badRequest('Enter how many jars were delivered.');

  const saved = await tx(async (t) => {
    const before = await t.one('SELECT * FROM delivery_entries WHERE customer_id = ? AND date = ? FOR UPDATE', [row.id, input.date]);
    await t.q(
      `INSERT INTO delivery_entries (customer_id, date, status, jars_delivered, empties_collected, rate_per_jar, remarks, delivery_boy_id, delivery_boy_name, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), jars_delivered = VALUES(jars_delivered), empties_collected = VALUES(empties_collected),
         remarks = VALUES(remarks), delivery_boy_id = NULL, delivery_boy_name = VALUES(delivery_boy_name), recorded_at = VALUES(recorded_at)`,
      [row.id, input.date, input.status, charged ? input.jarsDelivered : 0, charged ? input.emptiesCollected : 0, before?.rate_per_jar ?? row.rate_per_jar, input.remarks || null, `${req.admin.name} (office)`, toSqlDateTime()],
    );
    const entry = await t.one('SELECT * FROM delivery_entries WHERE customer_id = ? AND date = ?', [row.id, input.date]);
    await logActivity(
      req.actor,
      'entry.corrected',
      'entry',
      String(entry.id),
      { customerId: row.id, date: input.date, reason: input.reason, before: before ? mapEntry(before) : null, after: mapEntry(entry) },
      t,
    );
    return entry;
  });
  res.json(mapEntry(saved));
});

operationsRouter.delete('/entries/:customerId/:date', manager, async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Write why this entry is being removed').max(300) }), req.body);
  const before = await db.one('SELECT * FROM delivery_entries WHERE customer_id = ? AND date = ?', [req.params.customerId, req.params.date]);
  if (!before) throw notFound('No entry for this day');
  await db.q('DELETE FROM delivery_entries WHERE id = ?', [before.id]);
  await logActivity(req.actor, 'entry.deleted', 'entry', String(before.id), { reason, before: mapEntry(before) });
  res.json({ ok: true });
});

/* ---------------- Customer requests ---------------- */

operationsRouter.get('/requests', accounts, async (req, res) => {
  const f = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'resolved']).optional(), type: z.enum(['extra_jar', 'pause', 'resume', 'complaint']).optional(), customerId: z.string().optional() }), req.query);
  const where = [];
  const params = [];
  if (f.status) {
    where.push('q.status = ?');
    params.push(f.status);
  }
  if (f.type) {
    where.push('q.type = ?');
    params.push(f.type);
  }
  if (f.customerId) {
    where.push('q.customer_id = ?');
    params.push(f.customerId);
  }
  const rows = await db.q(
    `SELECT q.*, c.name AS customer_name, c.mobile AS customer_mobile, c.area AS customer_area
       FROM requests q JOIN customers c ON c.id = q.customer_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY q.created_at DESC LIMIT 500`,
    params,
  );
  res.json(rows.map((r) => ({ ...mapRequest(r), customerName: r.customer_name, customerMobile: r.customer_mobile, customerArea: r.customer_area })));
});

const DECISION_TEXT = {
  extra_jar: { approved: 'Your extra jar request was approved.', rejected: 'Sorry, we could not approve your extra jar request.' },
  pause: { approved: 'Your pause request was approved. Paused days are not charged.', rejected: 'Sorry, we could not approve your pause request.' },
  resume: { approved: 'Delivery will restart as requested.', rejected: 'Sorry, we could not approve your resume request.' },
  complaint: { resolved: 'Your complaint has been resolved.', rejected: 'Your complaint was closed.' },
};

/** Approve / reject a request (complaints: resolve). */
operationsRouter.post('/requests/:id/decision', manager, async (req, res) => {
  const { decision, note } = parse(z.object({ decision: z.enum(['approved', 'rejected', 'resolved']), note: z.string().trim().max(300).optional() }), req.body);
  const request = await db.one('SELECT * FROM requests WHERE id = ?', [req.params.id]);
  if (!request) throw notFound('Request not found');
  if (request.status !== 'pending') throw badRequest('This request has already been handled.');
  if (request.type === 'complaint' ? decision === 'approved' : decision === 'resolved') throw badRequest(`A ${request.type.replace('_', ' ')} request cannot be marked "${decision}".`);

  await tx(async (t) => {
    await t.q('UPDATE requests SET status = ?, admin_note = ?, handled_by = ?, handled_at = ? WHERE id = ?', [decision, note || null, req.admin.id, toSqlDateTime(), request.id]);
    if (request.type === 'resume' && decision === 'approved') {
      // Pauses starting on/after the resume day are cancelled; a pause already running ends the day before.
      await t.q("UPDATE requests SET status = 'rejected', admin_note = 'Cancelled by resume request' WHERE customer_id = ? AND type = 'pause' AND status = 'approved' AND from_date >= ?", [request.customer_id, request.from_date]);
      await t.q(
        "UPDATE requests SET to_date = ? WHERE customer_id = ? AND type = 'pause' AND status = 'approved' AND from_date < ? AND to_date >= ?",
        [addDays(request.from_date, -1), request.customer_id, request.from_date, request.from_date],
      );
      await t.q("DELETE FROM delivery_entries WHERE customer_id = ? AND status = 'paused' AND delivery_boy_id IS NULL AND date >= ?", [request.customer_id, request.from_date]);
    }
    const text = note || DECISION_TEXT[request.type]?.[decision] || `Your request was ${decision}.`;
    await notify(request.customer_id, 'request', request.type === 'complaint' ? 'Complaint update' : `Request ${decision}`, text, t);
    await logActivity(req.actor, `request.${decision}`, 'request', String(request.id), { type: request.type, customerId: request.customer_id, note }, t);
  });
  res.json(mapRequest(await db.one('SELECT * FROM requests WHERE id = ?', [request.id])));
});

/* ---------------- Payments ---------------- */

operationsRouter.get('/payments', accounts, async (req, res) => {
  const f = parse(z.object({ from: zDate.optional(), to: zDate.optional(), customerId: z.string().optional(), mode: z.enum(['cash', 'upi', 'online']).optional(), deliveryBoyId: z.coerce.number().int().optional() }), req.query);
  const where = ['p.date BETWEEN ? AND ?'];
  const params = [f.from ?? addDays(todayISO(), -30), f.to ?? todayISO()];
  if (f.customerId) {
    where.push('p.customer_id = ?');
    params.push(f.customerId);
  }
  if (f.mode) {
    where.push('p.mode = ?');
    params.push(f.mode);
  }
  if (f.deliveryBoyId) {
    where.push("p.recorded_by_type = 'delivery' AND p.recorded_by_id = ?");
    params.push(f.deliveryBoyId);
  }
  const rows = await db.q(`SELECT p.*, c.name AS customer_name FROM payments p JOIN customers c ON c.id = p.customer_id WHERE ${where.join(' AND ')} ORDER BY p.recorded_at DESC LIMIT 2000`, params);
  const items = rows.map((r) => ({ ...mapPayment(r), note: r.note ?? undefined }));
  const sum = (mode) => items.filter((p) => p.mode === mode).reduce((s, p) => s + p.amount, 0);
  const [cash, upi, online] = [sum('cash'), sum('upi'), sum('online')];
  res.json({ from: params[0], to: params[1], totals: { cash, upi, online, total: cash + upi + online, count: items.length }, items });
});

operationsRouter.post('/payments', accounts, async (req, res) => {
  const input = parse(
    z.object({
      customerId: z.string().trim().min(1),
      amount: z.coerce.number().positive('Enter the amount').max(1000000),
      mode: z.enum(['cash', 'upi']),
      reference: z.string().trim().max(60).optional(),
      date: zDate.optional(),
      note: z.string().trim().max(255).optional(),
    }),
    req.body,
  );
  const row = await getCustomerRow(input.customerId);
  if (!row) throw notFound('Customer not found');
  const payment = await tx(async (t) => {
    const r = await t.q(
      `INSERT INTO payments (customer_id, amount, mode, reference, date, note, recorded_by_type, recorded_by_id, recorded_by_name, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?)`,
      [row.id, input.amount, input.mode, input.reference || null, input.date ?? todayISO(), input.note || null, req.admin.id, `${req.admin.name} (office)`, toSqlDateTime()],
    );
    await notify(row.id, 'payment', 'Payment received', `₹${input.amount} received by ${input.mode === 'upi' ? 'UPI' : 'cash'} at the office. Thank you!`, t);
    await logActivity(req.actor, 'payment.recorded', 'payment', String(r.insertId), { customerId: row.id, amount: input.amount, mode: input.mode }, t);
    return t.one('SELECT p.*, c.name AS customer_name FROM payments p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?', [r.insertId]);
  });
  res.status(201).json(mapPayment(payment));
});

/** Reminders for customers with dues: in-app + SMS, plus WhatsApp links the office can tap. */
operationsRouter.post('/reminders/dues', accounts, async (req, res) => {
  const { minDues, sms } = parse(z.object({ minDues: z.coerce.number().min(1).default(1), sms: z.boolean().default(false) }), req.body);
  const today = todayISO();
  const dues = await duesByCustomer(today);
  const customers = await db.q('SELECT id, name, mobile FROM customers WHERE active = 1');
  const company = await db.one('SELECT name, phone FROM company WHERE id = 1');
  const sent = [];
  for (const c of customers) {
    const amount = dues.get(c.id) ?? 0;
    if (amount < minDues) continue;
    const text = `Dear ${c.name}, your water bill of ₹${amount} is pending (Customer ID ${c.id}). Please pay by cash or UPI. – ${company?.name ?? ''}`.trim();
    await notify(c.id, 'bill', 'Payment reminder', `₹${amount} is pending. Please pay by cash or UPI to your delivery boy or at the office.`);
    if (sms) await sendSms(c.mobile, text);
    sent.push({ customerId: c.id, name: c.name, mobile: c.mobile, dues: amount, whatsappUrl: `https://wa.me/91${c.mobile}?text=${encodeURIComponent(text)}` });
  }
  await logActivity(req.actor, 'reminders.sent', 'payment', null, { count: sent.length, sms });
  res.json({ count: sent.length, customers: sent });
});

/* ---------------- New connection enquiries ---------------- */

operationsRouter.get('/enquiries', accounts, async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['new', 'contacted', 'converted', 'closed']).optional() }), req.query);
  const rows = await db.q(`SELECT * FROM enquiries ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 500`, status ? [status] : []);
  res.json(
    rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      mobile: r.mobile,
      address: r.address,
      area: r.area,
      product: r.product,
      jarsPerDay: r.jars_per_day,
      schedule: r.schedule,
      message: r.message ?? undefined,
      source: r.source,
      status: r.status,
      customerId: r.customer_id ?? undefined,
      createdAt: fromSqlDateTime(r.created_at),
    })),
  );
});

operationsRouter.patch('/enquiries/:id', manager, async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['new', 'contacted', 'converted', 'closed']) }), req.body);
  const r = await db.q('UPDATE enquiries SET status = ? WHERE id = ?', [status, req.params.id]);
  if (!r.affectedRows) throw notFound('Enquiry not found');
  await logActivity(req.actor, 'enquiry.updated', 'enquiry', req.params.id, { status });
  res.json({ ok: true });
});

/* ---------------- Notifications & offers ---------------- */

operationsRouter.post('/notifications', manager, async (req, res) => {
  const input = parse(
    z.object({
      title: z.string().trim().min(2).max(120),
      body: z.string().trim().min(2).max(500),
      kind: z.enum(['offer', 'info']).default('info'),
      customerIds: z.array(z.string()).max(10000).optional(),
      routeId: z.coerce.number().int().optional(),
    }),
    req.body,
  );
  let ids = input.customerIds;
  if (!ids?.length) {
    const rows = await db.q(`SELECT id FROM customers WHERE active = 1 ${input.routeId ? 'AND route_id = ?' : ''}`, input.routeId ? [input.routeId] : []);
    ids = rows.map((r) => r.id);
  }
  if (ids.length) {
    await db.q('INSERT INTO notifications (customer_id, kind, title, body) VALUES ?', [ids.map((id) => [id, input.kind, input.title, input.body])]);
    pushTo('customer', ids, input.title, input.body, { kind: input.kind }).catch(() => undefined);
  }
  await logActivity(req.actor, 'notification.sent', 'notification', null, { title: input.title, count: ids.length });
  res.json({ sent: ids.length });
});

/* ---------------- Jar stock ---------------- */

operationsRouter.get('/jar-stock', accounts, async (_req, res) => {
  const totals = await db.q('SELECT type, SUM(qty) AS qty FROM jar_stock GROUP BY type');
  const t = Object.fromEntries(totals.map((r) => [r.type, Number(r.qty)]));
  const balances = await jarBalances();
  const withCustomers = balances.reduce((s, b) => s + Math.max(0, b.balance), 0);
  const today = todayISO();
  const emptiesToday = await db.one('SELECT COALESCE(SUM(empties_collected), 0) AS n, COALESCE(SUM(jars_delivered), 0) AS d FROM delivery_entries WHERE date = ?', [today]);
  const history = await db.q('SELECT * FROM jar_stock ORDER BY date DESC, id DESC LIMIT 100');
  const purchased = t.purchase ?? 0;
  const damaged = t.damaged ?? 0;
  const lost = t.lost ?? 0;
  res.json({
    purchased,
    damaged,
    lost,
    withCustomers,
    atPlant: purchased - damaged - lost - withCustomers,
    today: { date: today, delivered: Number(emptiesToday.d), emptiesCollected: Number(emptiesToday.n) },
    history: history.map((h) => ({ id: String(h.id), type: h.type, qty: h.qty, note: h.note ?? undefined, date: h.date })),
  });
});

operationsRouter.post('/jar-stock', manager, async (req, res) => {
  const input = parse(z.object({ type: z.enum(['purchase', 'damaged', 'lost']), qty: z.coerce.number().int().min(1).max(100000), note: z.string().trim().max(255).optional(), date: zDate.optional() }), req.body);
  const r = await db.q('INSERT INTO jar_stock (type, qty, note, admin_id, date) VALUES (?, ?, ?, ?, ?)', [input.type, input.qty, input.note || null, req.admin.id, input.date ?? todayISO()]);
  await logActivity(req.actor, `jar_stock.${input.type}`, 'jar_stock', String(r.insertId), input);
  res.status(201).json({ id: String(r.insertId) });
});
