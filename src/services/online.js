/** Online payments through Razorpay: in-app Checkout (Orders + native SDK) and Payment Links (browser). */
import { randomBytes } from 'node:crypto';
import { db, tx } from '../db.js';
import { logActivity, notify } from '../lib/activity.js';
import { round2 } from '../lib/billing.js';
import { fromSqlDateTime, todayISO, toSqlDateTime } from '../lib/dates.js';
import { badRequest, HttpError, notFound } from '../lib/http.js';
import {
  capturePayment,
  checkoutEnabled,
  createOrder,
  createPaymentLink,
  fetchOrderPayments,
  fetchPayment,
  fetchPaymentLink,
  razorpayEnabled,
  razorpayKeyId,
  verifyPaymentSignature,
} from '../lib/razorpay.js';

// Where the browser may send the customer back to: the app's own link scheme, or Expo Go while testing.
const RETURN_URL = /^(ashhar|ashhar-delivery|exp|exps):\/\/[^\s]*$/i;
const NOT_AVAILABLE = 'Online payment is not available yet. Please pay by cash or UPI to your delivery boy.';

export const mapOnline = (r) => ({
  id: String(r.id),
  amount: Number(r.amount),
  purpose: r.purpose,
  eventOrderId: r.event_order_id ? String(r.event_order_id) : undefined,
  status: r.status,
  url: r.short_url ?? undefined,
  createdAt: fromSqlDateTime(r.created_at),
  paidAt: fromSqlDateTime(r.paid_at) ?? undefined,
});

/** Works out what to charge and saves the online_payments row. */
async function prepare(customer, { purpose, amount, eventOrderId, returnUrl }) {
  let description = `Water bill – ${customer.name} (${customer.id})`;
  let orderId = null;
  if (purpose === 'event_order') {
    const o = await db.one('SELECT * FROM event_orders WHERE id = ? AND customer_id = ?', [eventOrderId, customer.id]);
    if (!o) throw notFound('Order not found');
    if (o.status === 'cancelled' || o.status === 'rejected') throw badRequest('This order was cancelled.');
    amount = (o.status === 'delivered' ? o.jars_delivered : o.quantity) * Number(o.rate_per_jar);
    description = `Event order #${o.id} – ${o.event_type} on ${o.event_date} (${customer.id})`;
    orderId = o.id;
  }
  amount = round2(Number(amount));
  if (!(amount >= 1)) throw badRequest('Amount must be at least ₹1.');
  if (amount > 200000) throw badRequest('For amounts above ₹2,00,000 please pay at the office.');

  const referenceId = `AR${Date.now().toString(36)}${randomBytes(4).toString('hex')}`.toUpperCase();
  const ins = await db.q('INSERT INTO online_payments (customer_id, amount, purpose, event_order_id, reference_id, return_url) VALUES (?, ?, ?, ?, ?, ?)', [
    customer.id,
    amount,
    purpose,
    orderId,
    referenceId,
    returnUrl && RETURN_URL.test(returnUrl) ? returnUrl.slice(0, 255) : null,
  ]);
  return { id: ins.insertId, amount, description, referenceId, notes: { customer_id: customer.id, purpose, online_payment_id: String(ins.insertId) } };
}

/** Payment Link flow (opens in a browser). */
export async function startOnlinePayment(customer, input) {
  if (!razorpayEnabled()) throw new HttpError(503, NOT_AVAILABLE);
  const p = await prepare(customer, input);
  const link = await createPaymentLink({ amount: p.amount, referenceId: p.referenceId, description: p.description, customer: { name: customer.name, mobile: customer.mobile }, notes: p.notes });
  await db.q('UPDATE online_payments SET link_id = ?, short_url = ? WHERE id = ?', [link.id, link.short_url, p.id]);
  await logActivity({ type: 'customer', id: customer.id, name: customer.name }, 'payment.online_started', 'online_payment', String(p.id), { amount: p.amount, purpose: input.purpose });
  return mapOnline(await db.one('SELECT * FROM online_payments WHERE id = ?', [p.id]));
}

/** In-app checkout: creates a Razorpay Order; the app opens the native checkout sheet with it. */
export async function startCheckout(customer, input) {
  if (!checkoutEnabled()) throw new HttpError(503, NOT_AVAILABLE);
  const p = await prepare(customer, input);
  const order = await createOrder({ amount: p.amount, receipt: p.referenceId, notes: p.notes });
  await db.q('UPDATE online_payments SET order_id = ? WHERE id = ?', [order.id, p.id]);
  await logActivity({ type: 'customer', id: customer.id, name: customer.name }, 'payment.online_started', 'online_payment', String(p.id), { amount: p.amount, purpose: input.purpose });
  return {
    id: String(p.id),
    keyId: razorpayKeyId(),
    orderId: order.id,
    amount: p.amount,
    amountPaise: Number(order.amount),
    currency: order.currency,
    description: p.description,
    prefill: { name: customer.name, contact: `+91${customer.mobile}` },
  };
}

/** A payment counts only if it belongs to this order, is for the full amount and is captured (captures it if only authorised). */
async function capturedPayment(op, payment) {
  const due = Math.round(Number(op.amount) * 100);
  if (!payment || payment.order_id !== op.order_id || Number(payment.amount) !== due || payment.currency !== 'INR') return null;
  if (payment.status === 'authorized') payment = await capturePayment(payment.id, due);
  return payment.status === 'captured' ? payment : null;
}

/** The app reports a finished checkout: check the signature, confirm with Razorpay, then record the payment. */
export async function confirmCheckout(customerId, { id, paymentId, orderId, signature }) {
  const op = await db.one('SELECT * FROM online_payments WHERE id = ? AND customer_id = ?', [id, customerId]);
  if (!op || !op.order_id) throw notFound('Payment not found');
  if (op.status === 'paid') return mapOnline(op);
  if (orderId !== op.order_id || !verifyPaymentSignature(op.order_id, paymentId, signature)) {
    throw badRequest('We could not verify this payment. If money was taken, it is added automatically within a few minutes — or call the office.');
  }
  const payment = await capturedPayment(op, await fetchPayment(paymentId));
  if (!payment) throw new HttpError(402, 'The payment was not completed. If money was taken, Razorpay refunds it automatically.');
  await recordPaid(op, { paymentId: payment.id, method: payment.method, amount: Number(payment.amount) / 100 });
  return mapOnline(await db.one('SELECT * FROM online_payments WHERE id = ?', [op.id]));
}

/** Saves a successful online payment exactly once — safe when the app, the webhook and a status check arrive together. */
async function recordPaid(op, { paymentId, method, amount }) {
  const paid = round2(amount);
  await tx(async (t) => {
    const upd = await t.q("UPDATE online_payments SET status = 'paid', paid_at = ?, razorpay_payment_id = ?, method = ? WHERE id = ? AND status = 'created'", [
      toSqlDateTime(),
      paymentId ?? null,
      method ?? null,
      op.id,
    ]);
    if (!upd.affectedRows) return; // someone else recorded it a moment ago
    const pay = await t.q(
      `INSERT INTO payments (client_id, customer_id, amount, mode, reference, date, note, recorded_by_type, recorded_by_name, recorded_at)
       VALUES (?, ?, ?, 'online', ?, ?, ?, 'online', 'Online (Razorpay)', ?)`,
      [`rzp_${op.order_id ?? op.link_id}`, op.customer_id, paid, paymentId ?? op.order_id ?? op.link_id, todayISO(), op.event_order_id ? `Event order #${op.event_order_id}` : null, toSqlDateTime()],
    );
    await t.q('UPDATE online_payments SET payment_id = ? WHERE id = ?', [pay.insertId, op.id]);
    await notify(op.customer_id, 'payment', 'Payment successful', `₹${paid} received online${method ? ` (${String(method).toUpperCase()})` : ''}. Thank you!`, t);
    await logActivity({ type: 'system', name: 'Razorpay' }, 'payment.online', 'payment', String(pay.insertId), { customerId: op.customer_id, amount: paid, method }, t);
  });
}

/**
 * Asks Razorpay whether this payment was made; if so records it exactly once.
 * Used by the app's status check, the browser redirect and the webhook.
 */
export async function settleOnlinePayment(op) {
  if (op.status !== 'created') return op.status;

  if (op.order_id) {
    const list = await fetchOrderPayments(op.order_id);
    for (const p of list.items ?? []) {
      const payment = await capturedPayment(op, p).catch(() => null);
      if (payment) {
        await recordPaid(op, { paymentId: payment.id, method: payment.method, amount: Number(payment.amount) / 100 });
        return 'paid';
      }
    }
    return 'created';
  }

  if (!op.link_id) return op.status;
  const link = await fetchPaymentLink(op.link_id);
  if (link.status === 'expired' || link.status === 'cancelled') {
    await db.q("UPDATE online_payments SET status = ? WHERE id = ? AND status = 'created'", [link.status, op.id]);
    return link.status;
  }
  if (link.status !== 'paid') return 'created';
  const rzpPayment = Array.isArray(link.payments) ? link.payments[0] : null;
  await recordPaid(op, { paymentId: rzpPayment?.payment_id, method: rzpPayment?.method, amount: Number(link.amount_paid ?? link.amount) / 100 });
  return 'paid';
}

export const findByLink = (linkId) => db.one('SELECT * FROM online_payments WHERE link_id = ?', [linkId]);
export const findByOrder = (orderId) => db.one('SELECT * FROM online_payments WHERE order_id = ?', [orderId]);
