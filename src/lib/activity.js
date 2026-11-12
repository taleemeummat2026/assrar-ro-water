import { db } from '../db.js';
import { pushTo } from './push.js';

/** Activity log entry ("who did what") — section 4.2. */
export async function logActivity(actor, action, entity, entityId, details, exec = db) {
  await exec.q('INSERT INTO activity_log (actor_type, actor_id, actor_name, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    actor?.type ?? 'system',
    actor?.id ?? null,
    actor?.name ?? 'System',
    action,
    entity ?? null,
    entityId ?? null,
    details ? JSON.stringify(details) : null,
  ]);
}

/** In-app notification for one customer (push notifications can hook in here later). */
export async function notify(customerId, kind, title, body, exec = db) {
  await exec.q('INSERT INTO notifications (customer_id, kind, title, body) VALUES (?, ?, ?, ?)', [customerId, kind, title.slice(0, 120), body.slice(0, 500)]);
  exec.onCommit(() => pushTo('customer', [customerId], title, body, { kind }));
}

/** Push to a delivery boy's phone (event order assigned, route cover …). */
export function notifyDeliveryBoy(boyId, title, body, data = {}, exec = db) {
  exec.onCommit(() => pushTo('delivery', [boyId], title, body, data));
}
