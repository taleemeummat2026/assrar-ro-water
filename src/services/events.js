/** Event orders (wedding, party, function …): create → assign → deliver. */
import { z } from 'zod';
import { db, tx } from '../db.js';
import { logActivity, notify, notifyDeliveryBoy } from '../lib/activity.js';
import { addDays, formatMonth, toSqlDateTime, todayISO } from '../lib/dates.js';
import { badRequest, notFound, zDate, zMobile } from '../lib/http.js';
import { EVENT_SELECT, mapEventOrder } from './data.js';

export const eventOrderSchema = z.object({
  eventType: z.string().trim().min(2, 'Choose the event type').max(40),
  eventDate: zDate,
  deliveryTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Pick a delivery time'),
  product: z.enum(['jar', 'camper']).optional(),
  quantity: z.coerce.number().int().min(1, 'At least 1 jar').max(1000, 'For more than 1000 jars please call the office'),
  address: z.string().trim().min(3).max(255).optional(),
  contactName: z.string().trim().max(100).optional(),
  contactMobile: zMobile.optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional(),
});

const niceDate = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  return `${day} ${formatMonth(`${y}-${String(m).padStart(2, '0')}`).slice(0, 3)}`;
};

export const getEventOrder = async (id, exec = db) => {
  const row = await exec.one(`${EVENT_SELECT} WHERE o.id = ?`, [id]);
  return row ? mapEventOrder(row) : null;
};

export async function createEventOrder(customerRow, input, createdBy, actor) {
  const today = todayISO();
  if (input.eventDate < today) throw badRequest('Pick today or a later date.');
  if (input.eventDate > addDays(today, 180)) throw badRequest('Orders can be placed up to 6 months ahead.');
  const product = input.product ?? customerRow.product;
  let rate = Number(customerRow.rate_per_jar);
  if (product !== customerRow.product) {
    const company = await db.one('SELECT jar_rate, camper_rate FROM company WHERE id = 1');
    rate = Number(product === 'camper' ? company?.camper_rate ?? 20 : company?.jar_rate ?? 15);
  }
  const id = await tx(async (t) => {
    const r = await t.q(
      `INSERT INTO event_orders (customer_id, event_type, event_date, delivery_time, product, quantity, rate_per_jar, address, contact_name, contact_mobile, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [customerRow.id, input.eventType, input.eventDate, input.deliveryTime, product, input.quantity, rate, input.address || customerRow.address, input.contactName || null, input.contactMobile || null, input.notes || null, createdBy],
    );
    await notify(customerRow.id, 'request', 'Event order received', `${input.quantity} jars for ${input.eventType} on ${niceDate(input.eventDate)} at ${input.deliveryTime}. We will confirm it shortly.`, t);
    await logActivity(actor, 'event_order.created', 'event_order', String(r.insertId), { customerId: customerRow.id, date: input.eventDate, quantity: input.quantity }, t);
    return r.insertId;
  });
  return getEventOrder(id);
}

/** Admin assigns (or re-assigns) a delivery boy. */
export async function assignEventOrder(order, input, actor) {
  if (!['pending', 'assigned'].includes(order.status)) throw badRequest(`This order is already ${order.status}.`);
  const boy = await db.one('SELECT id, name FROM delivery_boys WHERE id = ? AND active = 1', [input.deliveryBoyId]);
  if (!boy) throw badRequest('Choose an active delivery boy.');
  await tx(async (t) => {
    await t.q(
      `UPDATE event_orders SET status = 'assigned', delivery_boy_id = ?, assigned_at = ?, admin_note = COALESCE(?, admin_note),
         quantity = COALESCE(?, quantity), delivery_time = COALESCE(?, delivery_time), rate_per_jar = COALESCE(?, rate_per_jar) WHERE id = ?`,
      [boy.id, toSqlDateTime(), input.note || null, input.quantity ?? null, input.deliveryTime ?? null, input.ratePerJar ?? null, order.id],
    );
    await notify(order.customerId, 'request', 'Event order confirmed', `${boy.name} will deliver ${input.quantity ?? order.quantity} jars on ${niceDate(order.eventDate)} at ${input.deliveryTime ?? order.deliveryTime}.${input.note ? ` ${input.note}` : ''}`, t);
    notifyDeliveryBoy(boy.id, 'New event order', `${order.eventType}: ${input.quantity ?? order.quantity} jars on ${niceDate(order.eventDate)} at ${input.deliveryTime ?? order.deliveryTime} — ${order.address}`, { type: 'event_order', id: order.id }, t);
    if (order.deliveryBoyId && order.deliveryBoyId !== String(boy.id)) {
      notifyDeliveryBoy(order.deliveryBoyId, 'Event order moved', `The ${order.eventType} order on ${niceDate(order.eventDate)} was given to someone else.`, { type: 'event_order', id: order.id }, t);
    }
    await logActivity(actor, 'event_order.assigned', 'event_order', order.id, { deliveryBoy: boy.name, customerId: order.customerId }, t);
  });
  return getEventOrder(order.id);
}

/** Marks an event order delivered (delivery boy or office). Optional cash/UPI collected on the spot. */
export async function deliverEventOrder(order, input, actor, deliveredBy) {
  if (order.status === 'delivered') return order;
  if (order.status !== 'assigned' && order.status !== 'pending') throw badRequest(`This order is ${order.status}.`);
  if (input.jarsDelivered < 1) throw badRequest('Enter how many jars were delivered.');
  await tx(async (t) => {
    await t.q(
      "UPDATE event_orders SET status = 'delivered', jars_delivered = ?, empties_collected = ?, remarks = ?, delivered_at = ?, delivered_by_name = ?, delivery_boy_id = COALESCE(delivery_boy_id, ?) WHERE id = ? AND status <> 'delivered'",
      [input.jarsDelivered, input.emptiesCollected ?? 0, input.remarks || null, toSqlDateTime(), deliveredBy.name, deliveredBy.boyId ?? null, order.id],
    );
    if (input.payment && input.payment.amount > 0) {
      await t.q(
        `INSERT INTO payments (client_id, customer_id, amount, mode, reference, date, note, recorded_by_type, recorded_by_id, recorded_by_name, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.payment.clientId ?? null,
          order.customerId,
          input.payment.amount,
          input.payment.mode,
          input.payment.reference || null,
          todayISO(),
          `Event order #${order.id}`,
          deliveredBy.boyId ? 'delivery' : 'admin',
          deliveredBy.boyId ?? null,
          deliveredBy.name,
          toSqlDateTime(),
        ],
      );
    }
    const amount = input.jarsDelivered * order.ratePerJar;
    await notify(order.customerId, 'delivery', 'Event order delivered', `${input.jarsDelivered} jars delivered for your ${order.eventType}. ₹${amount} is added to your bill${input.payment?.amount ? `; ₹${input.payment.amount} received` : ''}.`, t);
    await logActivity(actor, 'event_order.delivered', 'event_order', order.id, { customerId: order.customerId, jars: input.jarsDelivered, payment: input.payment?.amount ?? 0 }, t);
  });
  return getEventOrder(order.id);
}

export async function cancelEventOrder(order, status, note, actor) {
  if (!['pending', 'assigned'].includes(order.status)) throw badRequest(`This order is already ${order.status}.`);
  await tx(async (t) => {
    await t.q('UPDATE event_orders SET status = ?, admin_note = COALESCE(?, admin_note) WHERE id = ?', [status, note || null, order.id]);
    if (actor.type !== 'customer') {
      await notify(order.customerId, 'request', status === 'rejected' ? 'Event order not accepted' : 'Event order cancelled', note || `Your order for ${niceDate(order.eventDate)} was ${status}. Please call the office for help.`, t);
    }
    if (order.deliveryBoyId) {
      notifyDeliveryBoy(order.deliveryBoyId, 'Event order cancelled', `${order.eventType} on ${niceDate(order.eventDate)} for ${order.customerName ?? order.customerId} is ${status}. Do not deliver.`, { type: 'event_order', id: order.id }, t);
    }
    await logActivity(actor, `event_order.${status}`, 'event_order', order.id, { customerId: order.customerId, note }, t);
  });
  return getEventOrder(order.id);
}

export function requireOrder(order) {
  if (!order) throw notFound('Order not found');
  return order;
}

