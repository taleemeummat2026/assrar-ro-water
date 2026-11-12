/** Online payments through Razorpay Payment Links. */
import { randomBytes } from 'node:crypto';
import { db, tx } from '../db.js';
import { logActivity, notify } from '../lib/activity.js';
import { round2 } from '../lib/billing.js';
import { fromSqlDateTime, todayISO, toSqlDateTime } from '../lib/dates.js';
import { badRequest, HttpError, notFound } from '../lib/http.js';
import { createPaymentLink, fetchPaymentLink, razorpayEnabled } from '../lib/razorpay.js';

// Where the browser may send the customer back to: the app's own link scheme, or Expo Go while testing.
const RETURN_URL = /^(ashhar|ashhar-delivery|exp|exps):\/\/[^\s]*$/i;

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

export async function startOnlinePayment(customer, { purpose, amount, eventOrderId, returnUrl }) {
  if (!razorpayEnabled()) throw new HttpError(503, 'Online payment is not available yet. Please pay by cash or UPI to your delivery boy.');
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
  const link = await createPaymentLink({
    amount,
    referenceId,
    description,
    customer: { name: customer.name, mobile: customer.mobile },
    notes: { customer_id: customer.id, purpose, online_payment_id: String(ins.insertId) },
  });
  await db.q('UPDATE online_payments SET link_id = ?, short_url = ? WHERE id = ?', [link.id, link.short_url, ins.insertId]);
  await logActivity({ type: 'customer', id: customer.id, name: customer.name }, 'payment.online_started', 'online_payment', String(ins.insertId), { amount, purpose });
  return mapOnline(await db.one('SELECT * FROM online_payments WHERE id = ?', [ins.insertId]));
}

/**
 * Asks Razorpay whether the link is paid; if so records the payment exactly once.
 * Safe to call from the redirect, the webhook and the app's status check at the same time.
 */
export async function settleOnlinePayment(op) {
  if (op.status !== 'created' || !op.link_id) return op.status;
  const link = await fetchPaymentLink(op.link_id);
  if (link.status === 'expired' || link.status === 'cancelled') {
    await db.q("UPDATE online_payments SET status = ? WHERE id = ? AND status = 'created'", [link.status, op.id]);
    return link.status;
  }
  if (link.status !== 'paid') return 'created';

  const paid = round2(Number(link.amount_paid ?? link.amount) / 100);
  const rzpPayment = Array.isArray(link.payments) ? link.payments[0] : null;
  await tx(async (t) => {
    const upd = await t.q("UPDATE online_payments SET status = 'paid', paid_at = ?, razorpay_payment_id = ?, method = ? WHERE id = ? AND status = 'created'", [
      toSqlDateTime(),
      rzpPayment?.payment_id ?? null,
      rzpPayment?.method ?? null,
      op.id,
    ]);
    if (!upd.affectedRows) return; // someone else recorded it a moment ago
    const pay = await t.q(
      `INSERT INTO payments (client_id, customer_id, amount, mode, reference, date, note, recorded_by_type, recorded_by_name, recorded_at)
       VALUES (?, ?, ?, 'online', ?, ?, ?, 'online', 'Online (Razorpay)', ?)`,
      [`rzp_${op.link_id}`, op.customer_id, paid, rzpPayment?.payment_id ?? op.link_id, todayISO(), op.event_order_id ? `Event order #${op.event_order_id}` : null, toSqlDateTime()],
    );
    await t.q('UPDATE online_payments SET payment_id = ? WHERE id = ?', [pay.insertId, op.id]);
    await notify(op.customer_id, 'payment', 'Payment successful', `₹${paid} received online${rzpPayment?.method ? ` (${rzpPayment.method.toUpperCase()})` : ''}. Thank you!`, t);
    await logActivity({ type: 'system', name: 'Razorpay' }, 'payment.online', 'payment', String(pay.insertId), { customerId: op.customer_id, amount: paid, method: rzpPayment?.method }, t);
  });
  return 'paid';
}

export const findByLink = (linkId) => db.one('SELECT * FROM online_payments WHERE link_id = ?', [linkId]);
