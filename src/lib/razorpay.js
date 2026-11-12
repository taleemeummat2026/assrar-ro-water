/**
 * Razorpay online payments via Payment Links (works in the app without any native SDK):
 *   1. app asks the API for a link → we create a Razorpay Payment Link
 *   2. customer pays in the browser (UPI / card / netbanking)
 *   3. Razorpay redirects to our callback and also sends a webhook
 *   4. we ask Razorpay for the link's status (server-to-server) and record the payment once
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from './http.js';

const BASE = 'https://api.razorpay.com/v1';

export const razorpayEnabled = () => !!(config.razorpay.keyId && config.razorpay.keySecret && config.publicUrl);

async function call(method, path, body) {
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, 'Could not reach the payment gateway. Please try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[razorpay]', res.status, data?.error);
    throw new HttpError(502, `Payment gateway error: ${data?.error?.description ?? res.status}`);
  }
  return data;
}

/** Creates a Payment Link. `amount` in rupees. Returns { id, short_url, status }. */
export function createPaymentLink({ amount, referenceId, description, customer, notes }) {
  return call('POST', '/payment_links', {
    amount: Math.round(amount * 100),
    currency: 'INR',
    accept_partial: false,
    reference_id: referenceId,
    description: description.slice(0, 2048),
    customer: { name: customer.name, contact: `+91${customer.mobile}` },
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes,
    expire_by: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    callback_url: `${config.publicUrl}/v1/public/razorpay/callback`,
    callback_method: 'get',
  });
}

export const fetchPaymentLink = (id) => call('GET', `/payment_links/${encodeURIComponent(id)}`);

/** Webhook check: HMAC-SHA256 of the raw body with the webhook secret (header X-Razorpay-Signature). */
export function verifyWebhook(rawBody, signature) {
  if (!config.razorpay.webhookSecret || !signature) return false;
  const expected = createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
