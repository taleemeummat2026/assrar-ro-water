/** Super Admin → event orders (wedding, party, function …) and online payments. */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.js';
import { logActivity } from '../../lib/activity.js';
import { requireAdmin } from '../../lib/auth.js';
import { addDays, todayISO } from '../../lib/dates.js';
import { badRequest, notFound, parse, zDate } from '../../lib/http.js';
import { EVENT_SELECT, getCustomerRow, mapEventOrder } from '../../services/data.js';
import { assignEventOrder, cancelEventOrder, createEventOrder, deliverEventOrder, eventOrderSchema, getEventOrder, requireOrder } from '../../services/events.js';
import { mapOnline } from '../../services/online.js';

export const eventsRouter = Router();
const manager = requireAdmin('manager');
const accounts = requireAdmin('manager', 'accounts');

eventsRouter.get('/event-orders', accounts, async (req, res) => {
  const f = parse(
    z.object({ status: z.enum(['pending', 'assigned', 'delivered', 'cancelled', 'rejected']).optional(), from: zDate.optional(), to: zDate.optional(), customerId: z.string().optional() }),
    req.query,
  );
  const where = [];
  const params = [];
  if (f.status) {
    where.push('o.status = ?');
    params.push(f.status);
  }
  if (f.from) {
    where.push('o.event_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('o.event_date <= ?');
    params.push(f.to);
  }
  if (f.customerId) {
    where.push('o.customer_id = ?');
    params.push(f.customerId);
  }
  const rows = await db.q(`${EVENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.event_date, o.delivery_time LIMIT 500`, params);
  res.json(rows.map(mapEventOrder));
});

/** Order taken on the phone by the office. */
eventsRouter.post('/event-orders', manager, async (req, res) => {
  const input = parse(eventOrderSchema.extend({ customerId: z.string().trim().min(1) }), req.body);
  const row = await getCustomerRow(input.customerId.toUpperCase());
  if (!row) throw notFound('Customer not found');
  res.status(201).json(await createEventOrder(row, input, 'admin', req.actor));
});

eventsRouter.post('/event-orders/:id/assign', manager, async (req, res) => {
  const input = parse(
    z.object({
      deliveryBoyId: z.coerce.number().int().positive(),
      note: z.string().trim().max(300).optional(),
      quantity: z.coerce.number().int().min(1).max(1000).optional(),
      deliveryTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      ratePerJar: z.coerce.number().positive().max(10000).optional(),
    }),
    req.body,
  );
  const order = requireOrder(await getEventOrder(req.params.id));
  res.json(await assignEventOrder(order, input, req.actor));
});

eventsRouter.post('/event-orders/:id/reject', manager, async (req, res) => {
  const { note } = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body);
  const order = requireOrder(await getEventOrder(req.params.id));
  res.json(await cancelEventOrder(order, 'rejected', note, req.actor));
});

eventsRouter.post('/event-orders/:id/deliver', manager, async (req, res) => {
  const input = parse(
    z.object({
      jarsDelivered: z.coerce.number().int().min(1).max(1000),
      emptiesCollected: z.coerce.number().int().min(0).max(1000).default(0),
      remarks: z.string().trim().max(300).optional(),
    }),
    req.body,
  );
  const order = requireOrder(await getEventOrder(req.params.id));
  res.json(await deliverEventOrder(order, input, req.actor, { name: `${req.admin.name} (office)` }));
});

/** Empty jars picked up after the event. */
eventsRouter.patch('/event-orders/:id', manager, async (req, res) => {
  const { emptiesCollected } = parse(z.object({ emptiesCollected: z.coerce.number().int().min(0).max(1000) }), req.body);
  const order = requireOrder(await getEventOrder(req.params.id));
  if (order.status !== 'delivered') throw badRequest('Empty jars can be recorded after delivery.');
  if (emptiesCollected > (order.jarsDelivered ?? 0) + 50) throw badRequest('That is more empties than jars delivered.');
  await db.q('UPDATE event_orders SET empties_collected = ? WHERE id = ?', [emptiesCollected, order.id]);
  await logActivity(req.actor, 'event_order.empties', 'event_order', order.id, { emptiesCollected });
  res.json(await getEventOrder(order.id));
});

/** Razorpay links created by customers (paid / waiting / expired). */
eventsRouter.get('/online-payments', accounts, async (req, res) => {
  const { from = addDays(todayISO(), -30) } = parse(z.object({ from: zDate.optional() }), req.query);
  const rows = await db.q(
    `SELECT op.*, c.name AS customer_name FROM online_payments op JOIN customers c ON c.id = op.customer_id
      WHERE op.created_at >= ? ORDER BY op.id DESC LIMIT 500`,
    [`${from} 00:00:00`],
  );
  res.json(rows.map((r) => ({ ...mapOnline(r), customerId: r.customer_id, customerName: r.customer_name, razorpayPaymentId: r.razorpay_payment_id ?? undefined, method: r.method ?? undefined })));
});
