/** Customer app API (App/API.md → "Customer app"). */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { logActivity } from '../lib/activity.js';
import { ensureApproved, requireCustomer } from '../lib/auth.js';
import { buildDays, buildMonthDays, lastNDays, pausedUntil, summarizeMonth } from '../lib/billing.js';
import { addDays, monthOf, todayISO } from '../lib/dates.js';
import { badRequest, notFound, parse, zDate, zMonth } from '../lib/http.js';
import { compact, customerAccount, EVENT_SELECT, getCustomerRow, mapCustomer, mapEventOrder, mapNotification, mapRequest } from '../services/data.js';
import { cancelEventOrder, createEventOrder, eventOrderSchema, getEventOrder, requireOrder } from '../services/events.js';
import { confirmCheckout, mapOnline, settleOnlinePayment, startCheckout, startOnlinePayment } from '../services/online.js';
import { checkoutEnabled } from '../lib/razorpay.js';
import { removePushToken, savePushToken } from '../lib/push.js';

export const customerRouter = Router();
customerRouter.use(requireCustomer);

async function account(req) {
  const today = todayISO();
  const row = await getCustomerRow(req.customerId);
  return { today, row, acc: await customerAccount(row, today) };
}

/** The logged-in customer (incl. sign-up status: pending / rejected / active). */
customerRouter.get('/me', async (req, res) => {
  res.json(mapCustomer(await getCustomerRow(req.customerId)));
});

customerRouter.get('/dashboard', async (req, res) => {
  const { today, row, acc } = await account(req);
  const [boy, unread] = await Promise.all([
    row.route_boy_id ? db.one('SELECT id, name, mobile FROM delivery_boys WHERE id = ?', [row.route_boy_id]) : null,
    db.one('SELECT COUNT(*) AS n FROM notifications WHERE customer_id = ? AND read_at IS NULL', [row.id]),
  ]);
  res.json(
    compact({
      customer: acc.customer,
      today: buildDays([today], acc.entries, acc.ctx)[0],
      last7Days: buildDays(lastNDays(7, today), acc.entries, acc.ctx),
      jarBalance: acc.jarBalance,
      dues: acc.dues,
      thisMonth: summarizeMonth(monthOf(today), acc.entries),
      deliveryBoy: boy ? { id: String(boy.id), name: boy.name, mobile: boy.mobile } : null,
      unreadNotifications: Number(unread.n),
      pausedUntil: pausedUntil(acc.requests, today) ?? pausedUntil(acc.requests, addDays(today, 1)),
      onlinePayments: checkoutEnabled(),
      upcomingEventOrders: acc.eventOrders.filter((o) => (o.status === 'pending' || o.status === 'assigned') && o.eventDate >= today).length,
    }),
  );
});

customerRouter.get('/calendar', async (req, res) => {
  const { month } = parse(z.object({ month: zMonth }), req.query);
  const { acc } = await account(req);
  res.json({ month, days: buildMonthDays(month, acc.entries, acc.ctx), summary: summarizeMonth(month, acc.entries) });
});

customerRouter.get('/bills', async (req, res) => {
  const { acc } = await account(req);
  res.json([...acc.bills].reverse());
});

customerRouter.get('/bills/:month', async (req, res) => {
  const { month } = parse(z.object({ month: zMonth }), req.params);
  const { acc } = await account(req);
  const bill = acc.bills.find((b) => b.month === month);
  if (!bill) throw notFound('No bill for this month.');
  const events = acc.eventOrders.filter((o) => o.status === 'delivered' && o.eventDate.startsWith(month));
  res.json({ ...bill, customer: acc.customer, days: buildMonthDays(month, acc.entries, acc.ctx), events });
});

customerRouter.get('/payments', async (req, res) => {
  const { acc } = await account(req);
  res.json(acc.payments);
});

customerRouter.get('/requests', async (req, res) => {
  const rows = await db.q('SELECT * FROM requests WHERE customer_id = ? ORDER BY created_at DESC, id DESC', [req.customerId]);
  res.json(rows.map(mapRequest));
});

const note = z.string().trim().max(500).optional();
const newRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('extra_jar'), date: zDate, jars: z.number().int().min(1, 'Choose between 1 and 20 extra jars.').max(20, 'Choose between 1 and 20 extra jars.'), message: note }),
  z.object({ type: z.literal('pause'), fromDate: zDate, toDate: zDate, message: note }),
  z.object({ type: z.literal('resume'), fromDate: zDate, message: note }),
  z.object({ type: z.literal('complaint'), topic: z.string().trim().min(1).max(60), message: z.string().trim().min(1, 'Please describe the problem.').max(500) }),
]);

customerRouter.post('/requests', async (req, res) => {
  ensureApproved(req);
  const input = parse(newRequest, req.body);
  const today = todayISO();
  if (input.type === 'extra_jar' && input.date < today) throw badRequest('Pick today or a later date.');
  if (input.type === 'pause') {
    if (input.fromDate < today) throw badRequest('Pause can start today or later.');
    if (input.toDate < input.fromDate) throw badRequest('The end date must be on or after the start date.');
    if (input.toDate > addDays(today, 120)) throw badRequest('Pause can be at most 4 months ahead. Please call the office for longer.');
  }
  if (input.type === 'resume' && input.fromDate < today) throw badRequest('Pick today or a later date.');

  const result = await db.q(
    'INSERT INTO requests (customer_id, type, date, jars, from_date, to_date, topic, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      req.customerId,
      input.type,
      input.type === 'extra_jar' ? input.date : null,
      input.type === 'extra_jar' ? input.jars : null,
      input.type === 'pause' || input.type === 'resume' ? input.fromDate : null,
      input.type === 'pause' ? input.toDate : null,
      input.type === 'complaint' ? input.topic : null,
      input.message || null,
    ],
  );
  await logActivity(req.actor, 'request.created', 'request', String(result.insertId), { type: input.type });
  const row = await db.one('SELECT * FROM requests WHERE id = ?', [result.insertId]);
  res.status(201).json(mapRequest(row));
});

customerRouter.get('/notifications', async (req, res) => {
  const rows = await db.q('SELECT * FROM notifications WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', [req.customerId]);
  res.json(rows.map(mapNotification));
});

customerRouter.post('/notifications/read', async (req, res) => {
  await db.q('UPDATE notifications SET read_at = CURRENT_TIMESTAMP(3) WHERE customer_id = ? AND read_at IS NULL', [req.customerId]);
  res.json({ ok: true });
});

/* ---------------- Event orders (wedding, party, function …) ---------------- */

customerRouter.get('/event-orders', async (req, res) => {
  const rows = await db.q(`${EVENT_SELECT} WHERE o.customer_id = ? ORDER BY o.event_date DESC, o.id DESC LIMIT 100`, [req.customerId]);
  res.json(rows.map(mapEventOrder));
});

customerRouter.post('/event-orders', async (req, res) => {
  ensureApproved(req);
  const input = parse(eventOrderSchema, req.body);
  const row = await getCustomerRow(req.customerId);
  res.status(201).json(await createEventOrder(row, input, 'customer', req.actor));
});

customerRouter.post('/event-orders/:id/cancel', async (req, res) => {
  const order = requireOrder(await getEventOrder(req.params.id));
  if (order.customerId !== req.customerId) throw notFound('Order not found');
  if (order.eventDate < todayISO()) throw badRequest('This order date has passed. Please call the office.');
  res.json(await cancelEventOrder(order, 'cancelled', null, req.actor));
});

/* ---------------- Online payment (Razorpay) ---------------- */

customerRouter.post('/online-payments', async (req, res) => {
  ensureApproved(req);
  const input = parse(
    z.object({
      purpose: z.enum(['dues', 'event_order']).default('dues'),
      amount: z.coerce.number().positive().optional(),
      eventOrderId: z.coerce.number().int().positive().optional(),
      returnUrl: z.string().max(255).optional(),
    }),
    req.body,
  );
  const row = await getCustomerRow(req.customerId);
  if (input.purpose === 'dues' && !input.amount) {
    const { acc } = await account(req);
    input.amount = acc.dues;
  }
  res.status(201).json(await startOnlinePayment(row, input));
});

/** In-app checkout: returns the Razorpay Order the app opens in the native checkout sheet. */
customerRouter.post('/online-payments/checkout', async (req, res) => {
  ensureApproved(req);
  const input = parse(
    z.object({
      purpose: z.enum(['dues', 'event_order']).default('dues'),
      amount: z.coerce.number().positive().optional(),
      eventOrderId: z.coerce.number().int().positive().optional(),
    }),
    req.body,
  );
  const row = await getCustomerRow(req.customerId);
  if (input.purpose === 'dues' && !input.amount) {
    const { acc } = await account(req);
    input.amount = acc.dues;
  }
  res.status(201).json(await startCheckout(row, input));
});

/** The app sends the checkout result; the server verifies it with Razorpay before recording the payment. */
customerRouter.post('/online-payments/:id/confirm', async (req, res) => {
  const input = parse(
    z.object({ paymentId: z.string().trim().min(1).max(40), orderId: z.string().trim().min(1).max(40), signature: z.string().trim().min(1).max(128) }),
    req.body,
  );
  res.json(await confirmCheckout(req.customerId, { id: req.params.id, ...input }));
});

/** The app checks this when the customer comes back from the payment page. */
customerRouter.get('/online-payments/:id', async (req, res) => {
  let op = await db.one('SELECT * FROM online_payments WHERE id = ? AND customer_id = ?', [req.params.id, req.customerId]);
  if (!op) throw notFound('Payment not found');
  if (op.status === 'created') {
    await settleOnlinePayment(op).catch(() => undefined);
    op = await db.one('SELECT * FROM online_payments WHERE id = ?', [op.id]);
  }
  res.json(mapOnline(op));
});


/* ---------------- Push notifications ---------------- */

const pushBody = z.object({ token: z.string().trim().regex(/^Expo(nent)?PushToken\[.+\]$/, 'Invalid push token').max(255) });

customerRouter.post('/push-token', async (req, res) => {
  const { token } = parse(pushBody, req.body);
  await savePushToken('customer', req.customerId, token);
  res.json({ ok: true });
});

customerRouter.delete('/push-token', async (req, res) => {
  const { token } = parse(pushBody, req.body);
  await removePushToken(token);
  res.json({ ok: true });
});
