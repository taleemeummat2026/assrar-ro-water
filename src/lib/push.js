/**
 * Push notifications through Expo's push service (works for both Android apps once they are built with EAS
 * and Firebase is set up — see README). Sending never blocks or breaks an API request.
 */
import { config } from '../config.js';
import { db } from '../db.js';

const URL = 'https://exp.host/--/api/v2/push/send';

async function send(messages) {
  if (!config.push.enabled || !messages.length) return;
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
          ...(config.push.accessToken ? { Authorization: `Bearer ${config.push.accessToken}` } : {}),
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(15_000),
      });
      const json = await res.json().catch(() => null);
      // Phones that uninstalled the app: stop sending to them.
      const gone = (json?.data ?? []).map((t, idx) => (t?.details?.error === 'DeviceNotRegistered' ? batch[idx].to : null)).filter(Boolean);
      if (gone.length) await db.q('DELETE FROM push_tokens WHERE token IN (?)', [gone]);
      if (!res.ok) console.error('[push] Expo answered', res.status, json?.errors ?? '');
    } catch (e) {
      console.error('[push] could not send:', e.message);
    }
  }
}

/** Push to every phone of the given customers / delivery boys. */
export async function pushTo(ownerType, ownerIds, title, body, data = {}) {
  if (!config.push.enabled) return;
  const ids = [...new Set(ownerIds.map(String))];
  if (!ids.length) return;
  const rows = await db.q('SELECT token FROM push_tokens WHERE owner_type = ? AND owner_id IN (?)', [ownerType, ids]);
  await send(rows.map((r) => ({ to: r.token, title, body, data, channelId: 'default', priority: 'high' })));
}

export async function savePushToken(ownerType, ownerId, token) {
  await db.q(
    `INSERT INTO push_tokens (token, owner_type, owner_id) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE owner_type = VALUES(owner_type), owner_id = VALUES(owner_id)`,
    [token, ownerType, String(ownerId)],
  );
}

export const removePushToken = (token) => db.q('DELETE FROM push_tokens WHERE token = ?', [token]);
