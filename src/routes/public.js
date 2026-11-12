/** No login needed: new connection enquiries (app + website) and company details. */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { logActivity } from '../lib/activity.js';
import { parse, zMobile } from '../lib/http.js';
import { verifyWebhook } from '../lib/razorpay.js';
import { findByLink, settleOnlinePayment } from '../services/online.js';

export const publicRouter = Router();

publicRouter.get('/company', async (_req, res) => {
  const c = await db.one('SELECT * FROM company WHERE id = 1');
  res.json({
    name: c?.name ?? '',
    nameHindi: c?.name_hindi ?? '',
    phone: c?.phone ?? '',
    whatsapp: c?.whatsapp ?? '',
    email: c?.email ?? '',
    address: c?.address ?? '',
    prices: c ? { jarRate: Number(c.jar_rate), camperRate: Number(c.camper_rate), jarDeposit: Number(c.jar_deposit), camperDeposit: Number(c.camper_deposit) } : null,
  });
});

/** New connection request — shows up in the Super Admin panel. */
publicRouter.post('/enquiries', async (req, res) => {
  const input = parse(
    z.object({
      name: z.string().trim().min(2, 'Enter your name').max(100),
      mobile: zMobile,
      address: z.string().trim().min(3, 'Enter your address').max(255),
      area: z.string().trim().max(80).optional(),
      product: z.enum(['jar', 'camper']).default('jar'),
      jarsPerDay: z.coerce.number().int().min(1).max(50).default(1),
      schedule: z.enum(['daily', 'alternate', 'weekdays']).default('daily'),
      message: z.string().trim().max(500).optional(),
      source: z.enum(['app', 'website']).default('app'),
    }),
    req.body,
  );
  const r = await db.q(
    'INSERT INTO enquiries (name, mobile, address, area, product, jars_per_day, schedule, message, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [input.name, input.mobile, input.address, input.area || null, input.product, input.jarsPerDay, input.schedule, input.message || null, input.source],
  );
  await logActivity({ type: 'system', name: `Enquiry (${input.source})` }, 'enquiry.created', 'enquiry', String(r.insertId), { name: input.name, mobile: input.mobile });
  res.status(201).json({ ok: true });
});

/* ---------------- Razorpay ---------------- */

const page = (title, text, ok) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f3f6fb;color:#1e293b}
div{background:#fff;padding:28px;border-radius:16px;max-width:360px;text-align:center;box-shadow:0 6px 24px rgba(10,39,76,.12)}
h1{color:${ok ? '#059669' : '#b45309'};font-size:22px}</style></head><body><div><h1>${title}</h1><p>${text}</p></div></body></html>`;

/** Razorpay sends the customer here after paying. We check with Razorpay, then send them back to the app. */
publicRouter.get('/razorpay/callback', async (req, res) => {
  const linkId = String(req.query.razorpay_payment_link_id ?? '');
  const op = linkId ? await findByLink(linkId) : null;
  if (!op) return res.status(404).send(page('Payment not found', 'Please open the app to check your payment.', false));
  const status = await settleOnlinePayment(op).catch(() => op.status);
  if (op.return_url) {
    const sep = op.return_url.includes('?') ? '&' : '?';
    return res.redirect(302, `${op.return_url}${sep}status=${status}&id=${op.id}`);
  }
  res.send(status === 'paid' ? page('Payment successful', 'Thank you! You can go back to the app now.', true) : page('Payment pending', 'We have not received the payment yet. Please check the app in a minute.', false));
});

/** Razorpay webhook (payment_link.paid). Mounted with the raw body in app.js so the signature can be checked. */
export async function razorpayWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verifyWebhook(raw, req.get('x-razorpay-signature'))) return res.status(400).json({ message: 'Invalid signature' });
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ message: 'Invalid JSON' });
  }
  const linkId = event?.payload?.payment_link?.entity?.id;
  if (String(event?.event ?? '').startsWith('payment_link.') && linkId) {
    const op = await findByLink(linkId);
    if (op) await settleOnlinePayment(op);
  }
  res.json({ ok: true });
}
