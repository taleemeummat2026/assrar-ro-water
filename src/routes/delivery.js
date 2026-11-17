/** Delivery boy app API (App/API.md → "Delivery app"). */
import { Router } from 'express';
import { z } from 'zod';
import { db, tx } from '../db.js';
import { logActivity, notify } from '../lib/activity.js';
import { requireDelivery } from '../lib/auth.js';
import { addDays, toSqlDateTime, todayISO } from '../lib/dates.js';
import { badRequest, notFound, parse, zDate } from '../lib/http.js';
import { upload } from '../lib/uploads.js';
import { removePushToken, savePushToken } from '../lib/push.js';
import { buildStops, CUSTOMER_SELECT, EVENT_SELECT, getCustomerRow, mapEntry, mapEventOrder, mapPayment, todayList } from '../services/data.js';
import { deliverEventOrder, getEventOrder, requireOrder } from '../services/events.js';
import { isReviewAccount, saveLocations, setDuty } from '../services/tracking.js';

export const deliveryRouter = Router();
deliveryRouter.use(requireDelivery);

const STATUS_TEXT = {
  delivered: 'Delivered',
  extra: 'Delivered (extra jars)',
  not_taken: 'Not taken – you had stock',
  not_available: 'Not available – we will try again',
  paused: 'Paused',
};

deliveryRouter.get('/today', async (req, res) => {
  const date = todayISO();
  const stops = await todayList(req.boy.id, date);
  const payments = await db.q(
    `SELECT p.*, c.name AS customer_name FROM payments p JOIN customers c ON c.id = p.customer_id
      WHERE p.date = ? AND p.recorded_by_type = 'delivery' AND p.recorded_by_id = ? ORDER BY p.recorded_at`,
    [date, req.boy.id],
  );
  res.json({ date, stops, payments: payments.map(mapPayment) });
});

deliveryRouter.get('/customers', async (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().max(60).default('') }), req.query);
  if (!q) return res.json([]);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const digits = q.replace(/\D/g, '');
  const rows = await db.q(
    `${CUSTOMER_SELECT}
      WHERE c.active = 1 AND (c.name LIKE ? OR c.id LIKE ? OR c.seq = ? OR (? AND c.mobile LIKE ?))
      ORDER BY c.seq LIMIT 30`,
    [like, like, digits.length >= 1 && digits.length <= 6 ? Number(digits) : -1, digits.length >= 4, `%${digits}%`],
  );
  res.json(await buildStops(rows, todayISO()));
});

deliveryRouter.get('/stops/:customerId', async (req, res) => {
  const row = await getCustomerRow(req.params.customerId);
  if (!row || !row.active) throw notFound('Customer not found');
  const [stop] = await buildStops([row], todayISO());
  res.json({ ...stop, sequence: 0 });
});

const entrySchema = z.object({
  clientId: z.string().trim().min(6).max(64),
  customerId: z.string().trim().min(1).max(12),
  date: zDate,
  status: z.enum(['delivered', 'extra', 'not_taken', 'not_available', 'paused']),
  jarsDelivered: z.coerce.number().int().min(0).max(100),
  emptiesCollected: z.coerce.number().int().min(0).max(100),
  remarks: z.string().trim().max(300).optional().nullable(),
  recordedAt: z.string().optional(),
  // Where the phone was when the entry was saved (sent while the delivery boy is on duty).
  location: z
    .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100_000).nullable().optional() })
    .nullable()
    .optional(),
});

/** Saves today's status for a customer. JSON, or multipart with `data` (JSON) + `photo`. */
deliveryRouter.put('/entries', upload.single('photo'), async (req, res) => {
  const body = req.is('multipart/form-data') ? JSON.parse(req.body?.data ?? '{}') : req.body;
  const input = parse(entrySchema, body);

  // The phone may resend after a timeout — answer with what was saved the first time.
  const receipt = await db.one('SELECT ref_id FROM sync_receipts WHERE client_id = ?', [input.clientId]);
  if (receipt) {
    const saved = await db.one('SELECT * FROM delivery_entries WHERE customer_id = ? AND date = ?', [input.customerId, input.date]);
    if (saved) return res.json(mapEntry(saved));
  }

  const row = await getCustomerRow(input.customerId);
  if (!row) throw notFound('Customer not found');
  const today = todayISO();
  if (input.date > today || input.date < addDays(today, -1)) {
    throw badRequest('Entries can only be saved for today. Ask the office to correct older days.');
  }
  const isDelivery = input.status === 'delivered' || input.status === 'extra';
  if (isDelivery && input.jarsDelivered < 1) throw badRequest('Enter how many jars were delivered.');
  const photoUrl = req.file ? `/uploads/entries/${req.file.filename}` : null;
  const boy = req.boy;
  const loc = isReviewAccount(boy.mobile) ? null : input.location; // store reviewers' positions never

  const saved = await tx(async (t) => {
    const before = await t.one('SELECT * FROM delivery_entries WHERE customer_id = ? AND date = ? FOR UPDATE', [row.id, input.date]);
    await t.q(
      `INSERT INTO delivery_entries
         (customer_id, date, status, jars_delivered, empties_collected, rate_per_jar, remarks, photo_url,
          delivery_boy_id, delivery_boy_name, client_id, recorded_at, lat, lng, location_accuracy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), jars_delivered = VALUES(jars_delivered),
         empties_collected = VALUES(empties_collected), rate_per_jar = VALUES(rate_per_jar), remarks = VALUES(remarks),
         photo_url = COALESCE(VALUES(photo_url), photo_url), delivery_boy_id = VALUES(delivery_boy_id),
         delivery_boy_name = VALUES(delivery_boy_name), client_id = VALUES(client_id), recorded_at = VALUES(recorded_at),
         lat = VALUES(lat), lng = VALUES(lng), location_accuracy = VALUES(location_accuracy)`,
      [
        row.id,
        input.date,
        input.status,
        isDelivery ? input.jarsDelivered : 0,
        isDelivery ? input.emptiesCollected : 0,
        row.rate_per_jar,
        input.remarks || null,
        photoUrl,
        boy.id,
        boy.name,
        input.clientId,
        toSqlDateTime(input.recordedAt ?? new Date()),
        loc?.lat ?? null,
        loc?.lng ?? null,
        loc?.accuracy == null ? null : Math.min(65_535, Math.round(loc.accuracy)),
      ],
    );
    const entry = await t.one('SELECT * FROM delivery_entries WHERE customer_id = ? AND date = ?', [row.id, input.date]);
    await t.q("INSERT IGNORE INTO sync_receipts (client_id, kind, ref_id) VALUES (?, 'entry', ?)", [input.clientId, entry.id]);
    const jars = entry.jars_delivered;
    await notify(
      row.id,
      'delivery',
      `${input.date === today ? 'Today' : 'Yesterday'}: ${STATUS_TEXT[entry.status]}`,
      isDelivery
        ? `${jars} jar${jars > 1 ? 's' : ''} delivered, ${entry.empties_collected} empty collected by ${boy.name}.`
        : `Marked by ${boy.name}. This day is not charged.`,
      t,
    );
    await logActivity(
      req.actor,
      before ? 'entry.updated' : 'entry.created',
      'entry',
      String(entry.id),
      {
        customerId: row.id,
        date: input.date,
        status: entry.status,
        jars,
        empties: entry.empties_collected,
        ...(before ? { before: { status: before.status, jars: before.jars_delivered, empties: before.empties_collected } } : {}),
      },
      t,
    );
    return entry;
  });

  res.json(mapEntry(saved));
});

const paymentSchema = z.object({
  clientId: z.string().trim().min(6).max(64),
  customerId: z.string().trim().min(1).max(12),
  amount: z.coerce.number().positive('Enter the amount collected.').max(100000),
  mode: z.enum(['cash', 'upi']),
  reference: z.string().trim().max(60).optional().nullable(),
  date: zDate,
  recordedAt: z.string().optional(),
});

deliveryRouter.post('/payments', async (req, res) => {
  const input = parse(paymentSchema, req.body);
  const existing = await db.one('SELECT p.*, c.name AS customer_name FROM payments p JOIN customers c ON c.id = p.customer_id WHERE p.client_id = ?', [input.clientId]);
  if (existing) return res.json(mapPayment(existing));

  const row = await getCustomerRow(input.customerId);
  if (!row) throw notFound('Customer not found');
  const boy = req.boy;

  const payment = await tx(async (t) => {
    const result = await t.q(
      `INSERT INTO payments (client_id, customer_id, amount, mode, reference, date, recorded_by_type, recorded_by_id, recorded_by_name, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, 'delivery', ?, ?, ?)`,
      [input.clientId, row.id, input.amount, input.mode, input.mode === 'upi' ? input.reference || null : null, input.date, boy.id, boy.name, toSqlDateTime(input.recordedAt ?? new Date())],
    );
    await t.q("INSERT IGNORE INTO sync_receipts (client_id, kind, ref_id) VALUES (?, 'payment', ?)", [input.clientId, result.insertId]);
    await notify(row.id, 'payment', 'Payment received', `₹${input.amount} received by ${input.mode === 'upi' ? 'UPI' : 'cash'} (collected by ${boy.name}). Thank you!`, t);
    await logActivity(req.actor, 'payment.collected', 'payment', String(result.insertId), { customerId: row.id, amount: input.amount, mode: input.mode }, t);
    return t.one('SELECT p.*, c.name AS customer_name FROM payments p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?', [result.insertId]);
  });
  res.status(201).json(mapPayment(payment));
});

/* ---------------- Event orders assigned to this delivery boy ---------------- */

deliveryRouter.get('/event-orders', async (req, res) => {
  const today = todayISO();
  const rows = await db.q(
    `${EVENT_SELECT}
      WHERE o.delivery_boy_id = ? AND ((o.status = 'assigned' AND o.event_date >= ?) OR (o.status = 'delivered' AND o.event_date >= ?))
      ORDER BY o.status = 'delivered', o.event_date, o.delivery_time`,
    [req.boy.id, addDays(today, -7), addDays(today, -2)],
  );
  res.json(rows.map(mapEventOrder));
});

deliveryRouter.post('/event-orders/:id/deliver', async (req, res) => {
  const input = parse(
    z.object({
      jarsDelivered: z.coerce.number().int().min(1).max(1000),
      emptiesCollected: z.coerce.number().int().min(0).max(1000).default(0),
      remarks: z.string().trim().max(300).optional(),
      payment: z
        .object({ clientId: z.string().trim().min(6).max(64).optional(), amount: z.coerce.number().min(0).max(1000000), mode: z.enum(['cash', 'upi']), reference: z.string().trim().max(60).optional() })
        .optional(),
    }),
    req.body,
  );
  const order = requireOrder(await getEventOrder(req.params.id));
  if (order.deliveryBoyId !== String(req.boy.id)) throw notFound('This order is not assigned to you.');
  res.json(await deliverEventOrder(order, input, req.actor, { boyId: req.boy.id, name: req.boy.name }));
});


/* ---------------- Live location (while on duty) ---------------- */

const pointSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100_000).nullable().optional(),
    speed: z.number().max(1_000).nullable().optional(),
    heading: z.number().max(360).nullable().optional(),
    recordedAt: z.string().max(40),
  })
  .refine((p) => p.lat !== 0 || p.lng !== 0, 'Invalid location');

/** Positions from the phone, oldest first (several at once after a network gap). */
deliveryRouter.post('/location', async (req, res) => {
  const { points } = parse(z.object({ points: z.array(pointSchema).min(1).max(500) }), req.body);
  if (isReviewAccount(req.boy.mobile)) return res.json({ ok: true, saved: 0 });
  res.json({ ok: true, ...(await saveLocations(req.boy.id, points)) });
});

/** Start duty / End duty. Optional `point` = the position when the button was pressed. */
deliveryRouter.post('/duty', async (req, res) => {
  const input = parse(z.object({ onDuty: z.boolean(), point: pointSchema.optional() }), req.body);
  if (isReviewAccount(req.boy.mobile)) return res.json({ ok: true, onDuty: input.onDuty });
  // The end position is saved before going off duty, the start position after going on duty.
  if (input.point && !input.onDuty) await saveLocations(req.boy.id, [input.point]);
  await setDuty(req.boy, req.actor, input.onDuty);
  if (input.point && input.onDuty) await saveLocations(req.boy.id, [input.point]);
  res.json({ ok: true, onDuty: input.onDuty });
});

/* ---------------- Push notifications ---------------- */

const pushBody = z.object({ token: z.string().trim().regex(/^Expo(nent)?PushToken\[.+\]$/, 'Invalid push token').max(255) });

deliveryRouter.post('/push-token', async (req, res) => {
  const { token } = parse(pushBody, req.body);
  await savePushToken('delivery', req.boy.id, token);
  res.json({ ok: true });
});

deliveryRouter.delete('/push-token', async (req, res) => {
  const { token } = parse(pushBody, req.body);
  await removePushToken(token);
  res.json({ ok: true });
});
