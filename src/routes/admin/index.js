/** Super Admin web app API: dashboard, settings, users, activity log + the other admin routers. */
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.js';
import { logActivity } from '../../lib/activity.js';
import { requireAdmin } from '../../lib/auth.js';
import { fromSqlDateTime, todayISO } from '../../lib/dates.js';
import { notFound, parse, zDate, zMobile } from '../../lib/http.js';
import { dayView, duesByCustomer, jarBalances } from '../../services/admin.js';
import { customersRouter } from './customers.js';
import { eventsRouter } from './events.js';
import { razorpayEnabled } from '../../lib/razorpay.js';
import { operationsRouter } from './operations.js';
import { reportsRouter } from './reports.js';

export const adminRouter = Router();
const anyAdmin = requireAdmin('manager', 'accounts');
const ownerOnly = requireAdmin();

adminRouter.get('/me', anyAdmin, (req, res) => {
  res.json({ id: String(req.admin.id), name: req.admin.name, mobile: req.admin.mobile, role: req.admin.role });
});

/** Dashboard: today's deliveries, pending, not taken, collections (quotation 4.2). */
adminRouter.get('/dashboard', anyAdmin, async (req, res) => {
  const { date = todayISO() } = parse(z.object({ date: zDate.optional() }), req.query);
  const [view, pay, dues, balances, pendingRequests, newEnquiries, customers, events] = await Promise.all([
    dayView(date),
    db.q(
      `SELECT mode, recorded_by_type, recorded_by_id, SUM(amount) AS amount FROM payments WHERE date = ?
        GROUP BY mode, recorded_by_type, recorded_by_id`,
      [date],
    ),
    duesByCustomer(),
    jarBalances(),
    db.one("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'"),
    db.one("SELECT COUNT(*) AS n FROM enquiries WHERE status = 'new'"),
    db.one('SELECT COUNT(*) AS total, SUM(active) AS active FROM customers'),
    db.one("SELECT SUM(status = 'pending') AS pending, SUM(status = 'assigned' AND event_date >= ?) AS upcoming, SUM(status IN ('pending','assigned') AND event_date = ?) AS today FROM event_orders", [date, date]),
  ]);

  const byBoy = new Map();
  for (const r of view.rows) {
    if (!r.deliveryBoyId || r.kind === 'off' || r.kind === 'inactive') continue;
    const b = byBoy.get(r.deliveryBoyId) ?? { id: r.deliveryBoyId, name: r.deliveryBoyName, total: 0, done: 0, pending: 0, cash: 0, upi: 0 };
    b.total++;
    if (r.entry) b.done++;
    else b.pending++;
    byBoy.set(r.deliveryBoyId, b);
  }
  let cash = 0;
  let upi = 0;
  let online = 0;
  for (const p of pay) {
    const amount = Number(p.amount);
    if (p.mode === 'cash') cash += amount;
    else if (p.mode === 'upi') upi += amount;
    else online += amount;
    if (p.recorded_by_type === 'delivery' && byBoy.has(String(p.recorded_by_id))) byBoy.get(String(p.recorded_by_id))[p.mode] += amount;
  }

  res.json({
    date,
    customers: { total: Number(customers.total), active: Number(customers.active ?? 0) },
    deliveries: view.counts,
    jars: { deliveredToday: view.counts.jarsDelivered, emptiesToday: view.counts.emptiesCollected, withCustomers: balances.reduce((s, b) => s + Math.max(0, b.balance), 0) },
    collections: { cash, upi, online, total: cash + upi + online },
    eventOrders: { pending: Number(events?.pending ?? 0), upcoming: Number(events?.upcoming ?? 0), today: Number(events?.today ?? 0) },
    onlinePayments: razorpayEnabled(),
    outstanding: { total: [...dues.values()].filter((d) => d > 0).reduce((s, d) => s + d, 0), customers: [...dues.values()].filter((d) => d > 0).length },
    pendingRequests: Number(pendingRequests.n),
    newEnquiries: Number(newEnquiries.n),
    byDeliveryBoy: [...byBoy.values()],
    // Missed / not-updated customers, highlighted at day end.
    notUpdated: view.rows.filter((r) => r.kind === 'pending' || r.kind === 'missed').map((r) => ({ customerId: r.customerId, name: r.name, area: r.area, deliveryBoyName: r.deliveryBoyName })),
  });
});

/* ---------------- Company profile ---------------- */

const companyOut = (c) => ({
  name: c.name,
  nameHindi: c.name_hindi ?? '',
  phone: c.phone ?? '',
  whatsapp: c.whatsapp ?? '',
  email: c.email ?? '',
  address: c.address ?? '',
  gstin: c.gstin ?? '',
  logoUrl: c.logo_url ?? '',
  prices: { jarRate: Number(c.jar_rate), camperRate: Number(c.camper_rate), jarDeposit: Number(c.jar_deposit), camperDeposit: Number(c.camper_deposit) },
});

adminRouter.get('/company', anyAdmin, async (_req, res) => {
  res.json(companyOut(await db.one('SELECT * FROM company WHERE id = 1')));
});

adminRouter.put('/company', ownerOnly, async (req, res) => {
  const input = parse(
    z.object({
      name: z.string().trim().min(2).max(120),
      nameHindi: z.string().trim().max(120).optional(),
      phone: z.string().trim().max(20).optional(),
      whatsapp: z.string().trim().max(20).optional(),
      email: z.string().trim().max(120).optional(),
      address: z.string().trim().max(255).optional(),
      gstin: z.string().trim().max(20).optional(),
      logoUrl: z.string().trim().max(255).optional(),
      prices: z.object({ jarRate: z.number().positive(), camperRate: z.number().positive(), jarDeposit: z.number().min(0), camperDeposit: z.number().min(0) }).partial().optional(),
    }),
    req.body,
  );
  const p = input.prices ?? {};
  await db.q(
    `UPDATE company SET name = ?, name_hindi = ?, phone = ?, whatsapp = ?, email = ?, address = ?, gstin = ?, logo_url = ?,
       jar_rate = COALESCE(?, jar_rate), camper_rate = COALESCE(?, camper_rate), jar_deposit = COALESCE(?, jar_deposit), camper_deposit = COALESCE(?, camper_deposit)
     WHERE id = 1`,
    [input.name, input.nameHindi ?? null, input.phone ?? null, input.whatsapp ?? null, input.email ?? null, input.address ?? null, input.gstin ?? null, input.logoUrl ?? null, p.jarRate ?? null, p.camperRate ?? null, p.jarDeposit ?? null, p.camperDeposit ?? null],
  );
  await logActivity(req.actor, 'company.updated', 'company', '1', input);
  res.json(companyOut(await db.one('SELECT * FROM company WHERE id = 1')));
});

/* ---------------- Admin users (unlimited, role-based) ---------------- */

adminRouter.get('/users', ownerOnly, async (_req, res) => {
  const rows = await db.q('SELECT id, name, mobile, role, active, created_at FROM admin_users ORDER BY active DESC, name');
  res.json(rows.map((u) => ({ id: String(u.id), name: u.name, mobile: u.mobile, role: u.role, active: !!u.active, createdAt: fromSqlDateTime(u.created_at) })));
});

const roleEnum = z.enum(['owner', 'manager', 'accounts']);

adminRouter.post('/users', ownerOnly, async (req, res) => {
  const input = parse(z.object({ name: z.string().trim().min(2).max(80), mobile: zMobile, password: z.string().min(6, 'Password must be at least 6 characters').max(64), role: roleEnum }), req.body);
  const r = await db.q('INSERT INTO admin_users (name, mobile, password_hash, role) VALUES (?, ?, ?, ?)', [input.name, input.mobile, await bcrypt.hash(input.password, 10), input.role]);
  await logActivity(req.actor, 'admin_user.created', 'admin_user', String(r.insertId), { name: input.name, role: input.role });
  res.status(201).json({ id: String(r.insertId) });
});

adminRouter.patch('/users/:id', ownerOnly, async (req, res) => {
  const input = parse(z.object({ name: z.string().trim().min(2).max(80), mobile: zMobile, password: z.string().min(6).max(64), role: roleEnum, active: z.boolean() }).partial(), req.body);
  const cols = {
    name: input.name,
    mobile: input.mobile,
    password_hash: input.password ? await bcrypt.hash(input.password, 10) : undefined,
    role: input.role,
    active: input.active === undefined ? undefined : input.active ? 1 : 0,
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (set.length) {
    const r = await db.q(`UPDATE admin_users SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [...set.map(([, v]) => v), req.params.id]);
    if (!r.affectedRows) throw notFound('User not found');
    await logActivity(req.actor, 'admin_user.updated', 'admin_user', req.params.id, { ...input, password: input.password ? '(changed)' : undefined });
  }
  res.json({ ok: true });
});

/* ---------------- Activity log ---------------- */

adminRouter.get('/activity', anyAdmin, async (req, res) => {
  const f = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional(), entity: z.string().optional(), entityId: z.string().optional(), actorType: z.enum(['admin', 'delivery', 'customer', 'system']).optional() }), req.query);
  const where = [];
  const params = [];
  if (f.before) {
    where.push('id < ?');
    params.push(f.before);
  }
  if (f.entity) {
    where.push('entity = ?');
    params.push(f.entity);
  }
  if (f.entityId) {
    where.push('entity_id = ?');
    params.push(f.entityId);
  }
  if (f.actorType) {
    where.push('actor_type = ?');
    params.push(f.actorType);
  }
  const rows = await db.q(`SELECT * FROM activity_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, [...params, f.limit]);
  res.json(
    rows.map((r) => ({
      id: String(r.id),
      actorType: r.actor_type,
      actorId: r.actor_id,
      actorName: r.actor_name,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      details: r.details ? JSON.parse(r.details) : null,
      createdAt: fromSqlDateTime(r.created_at),
    })),
  );
});

adminRouter.use('/customers', customersRouter);
adminRouter.use('/reports', reportsRouter);
adminRouter.use('/', eventsRouter);
adminRouter.use('/', operationsRouter);
