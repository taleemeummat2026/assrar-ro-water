/**
 * Live tracking of delivery boys.
 *
 * While a delivery boy is on duty (Start duty → End duty in his app) the phone sends its GPS position
 * every ~30 seconds. The newest position goes to `delivery_locations` (where he is now) and a thinned copy
 * to `location_points` (the path he took that day). The admin panel shows both on a map.
 */
import { config } from '../config.js';
import { db, tx } from '../db.js';
import { logActivity } from '../lib/activity.js';
import { CHARGED } from '../lib/billing.js';
import { fromSqlDateTime, toSqlDateTime, todayISO } from '../lib/dates.js';
import { dayView } from './admin.js';

/** A position younger than this counts as "live" (the phone sends one every ~30 s). */
export const LIVE_SECONDS = 150;
const MIN_STEP_M = 20; // keep a path point every 20 m …
const MAX_GAP_MS = 3 * 60_000; // … or every 3 minutes while standing still
const MAX_PATH_ACCURACY_M = 100; // rougher fixes still update "where now" but stay out of the path
const MAX_AGE_MS = 2 * 86_400_000; // points saved offline longer ago than this are ignored
const MAX_SPEED_MS = 42; // ~150 km/h — faster jumps are GPS glitches, not travel

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const toMs = (sql) => (sql ? Date.parse(fromSqlDateTime(sql)) : 0);
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Store-review logins (config.reviewMobiles, e.g. the Google Play reviewer's 9999999999) are not real staff:
 * their location is never stored and they are left off the admin map.
 */
export const isReviewAccount = (mobile) => config.reviewMobiles.has(String(mobile));

/** Straight-line distance in metres. */
export function distanceM(a, b) {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Phone points → oldest first; a phone clock running ahead is pulled back to the server's time. */
function cleanPoints(points, now) {
  return points
    .map((p) => {
      const t = Math.min(Date.parse(p.recordedAt) || now, now);
      return {
        lat: round(p.lat, 6),
        lng: round(p.lng, 6),
        accuracy: p.accuracy === null || p.accuracy === undefined ? null : Math.min(65_535, Math.round(p.accuracy)),
        speed: p.speed === null || p.speed === undefined || p.speed < 0 ? null : Math.min(9_999, round(p.speed, 1)),
        heading: p.heading === null || p.heading === undefined || p.heading < 0 ? null : Math.round(p.heading) % 360,
        t,
      };
    })
    .filter((p) => p.t >= now - MAX_AGE_MS)
    .sort((a, b) => a.t - b.t);
}

/**
 * Saves positions sent by a delivery boy's phone (newest = where he is now).
 * Safe to resend: points older than the end of his saved path are skipped.
 */
export async function saveLocations(boyId, points) {
  const now = Date.now();
  const list = cleanPoints(points, now);
  if (!list.length) return { saved: 0 };

  return tx(async (t) => {
    const current = await t.one('SELECT * FROM delivery_locations WHERE delivery_boy_id = ? FOR UPDATE', [boyId]);
    // Newest path point — ordered like the index (boy, date, time) so it is one index lookup, not a scan of 30 days.
    const last = await t.one('SELECT lat, lng, recorded_at FROM location_points WHERE delivery_boy_id = ? ORDER BY date DESC, recorded_at DESC LIMIT 1', [boyId]);
    let lastT = last ? toMs(last.recorded_at) : 0;
    let lastPos = last ? { lat: Number(last.lat), lng: Number(last.lng) } : null;

    const rows = [];
    for (const p of list) {
      if (p.t <= lastT) continue;
      if (p.accuracy !== null && p.accuracy > MAX_PATH_ACCURACY_M) continue;
      if (lastPos && distanceM(lastPos, p) < MIN_STEP_M && p.t - lastT < MAX_GAP_MS) continue;
      rows.push([boyId, todayISO(new Date(p.t)), p.lat, p.lng, p.accuracy, p.speed, toSqlDateTime(new Date(p.t))]);
      lastPos = p;
      lastT = p.t;
    }
    if (rows.length) {
      await t.q('INSERT INTO location_points (delivery_boy_id, date, lat, lng, accuracy, speed, recorded_at) VALUES ?', [rows]);
    }

    const newest = list[list.length - 1];
    const received = toSqlDateTime(new Date(now));
    if (!current) {
      await t.q(
        `INSERT INTO delivery_locations (delivery_boy_id, on_duty, duty_started_at, lat, lng, accuracy, speed, heading, recorded_at, received_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [boyId, toSqlDateTime(new Date(list[0].t)), newest.lat, newest.lng, newest.accuracy, newest.speed, newest.heading, toSqlDateTime(new Date(newest.t)), received],
      );
    } else if (newest.t >= toMs(current.recorded_at)) {
      // A point sent after "End duty" (late retry) must not switch him back on duty.
      const endedAt = toMs(current.duty_ended_at);
      const onDuty = current.on_duty ? 1 : newest.t > endedAt ? 1 : 0;
      const startedAt = !current.on_duty && onDuty ? toSqlDateTime(new Date(newest.t)) : current.duty_started_at;
      await t.q(
        `UPDATE delivery_locations SET on_duty = ?, duty_started_at = ?, lat = ?, lng = ?, accuracy = ?, speed = ?, heading = ?,
                recorded_at = ?, received_at = ? WHERE delivery_boy_id = ?`,
        [onDuty, startedAt, newest.lat, newest.lng, newest.accuracy, newest.speed, newest.heading, toSqlDateTime(new Date(newest.t)), received, boyId],
      );
    } else {
      await t.q('UPDATE delivery_locations SET received_at = ? WHERE delivery_boy_id = ?', [received, boyId]);
    }
    return { saved: rows.length };
  });
}

/** Start duty / End duty from the delivery app. */
export async function setDuty(boy, actor, onDuty) {
  const now = toSqlDateTime();
  await tx(async (t) => {
    const current = await t.one('SELECT on_duty, duty_started_at FROM delivery_locations WHERE delivery_boy_id = ? FOR UPDATE', [boy.id]);
    if (onDuty) {
      // Pressing Start again the same day keeps the first start time.
      const keepStart = current?.on_duty && current.duty_started_at && todayISO(new Date(toMs(current.duty_started_at))) === todayISO();
      await t.q(
        `INSERT INTO delivery_locations (delivery_boy_id, on_duty, duty_started_at, duty_ended_at) VALUES (?, 1, ?, NULL)
         ON DUPLICATE KEY UPDATE on_duty = 1, duty_started_at = VALUES(duty_started_at), duty_ended_at = NULL`,
        [boy.id, keepStart ? current.duty_started_at : now],
      );
      if (!keepStart) await logActivity(actor, 'duty.started', 'delivery_boy', String(boy.id), null, t);
    } else {
      await t.q(
        `INSERT INTO delivery_locations (delivery_boy_id, on_duty, duty_ended_at) VALUES (?, 0, ?)
         ON DUPLICATE KEY UPDATE on_duty = 0, duty_ended_at = VALUES(duty_ended_at)`,
        [boy.id, now],
      );
      if (current?.on_duty) await logActivity(actor, 'duty.ended', 'delivery_boy', String(boy.id), null, t);
    }
  });
}

function mapLocation(row) {
  if (!row || row.lat === null || row.lng === null) return null;
  return {
    lat: Number(row.lat),
    lng: Number(row.lng),
    accuracy: num(row.accuracy),
    speed: num(row.speed),
    heading: num(row.heading),
    recordedAt: fromSqlDateTime(row.recorded_at),
  };
}

/**
 * Admin "Live tracking": every active delivery boy with where he is now, how fresh that is,
 * today's progress, the last customer he marked and the next one on his list.
 */
export async function liveView(now = new Date()) {
  const today = todayISO(now);
  const [boys, locations, view, entries, routes, pins] = await Promise.all([
    db.q('SELECT id, name, mobile FROM delivery_boys WHERE active = 1 ORDER BY name'),
    db.q('SELECT * FROM delivery_locations'),
    dayView(today),
    db.q(
      `SELECT e.delivery_boy_id, e.customer_id, c.name, c.area, e.status, e.jars_delivered, e.recorded_at
         FROM delivery_entries e JOIN customers c ON c.id = e.customer_id
        WHERE e.date = ? AND e.delivery_boy_id IS NOT NULL ORDER BY e.recorded_at DESC`,
      [today],
    ),
    db.q(
      `SELECT r.name, COALESCE(rc.delivery_boy_id, r.delivery_boy_id) AS boy_id FROM routes r
         LEFT JOIN route_covers rc ON rc.route_id = r.id AND rc.date = ?
        WHERE r.active = 1 ORDER BY r.sort_order, r.id`,
      [today],
    ),
    db.q('SELECT id, lat, lng FROM customers WHERE active = 1 AND lat IS NOT NULL AND lng IS NOT NULL'),
  ]);

  const locBy = new Map(locations.map((l) => [String(l.delivery_boy_id), l]));
  const pinBy = new Map(pins.map((p) => [p.id, { lat: Number(p.lat), lng: Number(p.lng) }]));
  const nowMs = now.getTime();
  const counts = { live: 0, no_signal: 0, off_duty: 0, never: 0 };

  const list = boys.filter((b) => !isReviewAccount(b.mobile)).map((b) => {
    const id = String(b.id);
    const row = locBy.get(id);
    const location = mapLocation(row);
    const ageSeconds = location ? Math.max(0, Math.round((nowMs - Date.parse(location.recordedAt)) / 1000)) : null;
    // Duty left on since an earlier day (phone switched off, app removed …) counts as off duty.
    const lastSign = Math.max(toMs(row?.duty_started_at), toMs(row?.recorded_at));
    const onDuty = !!row?.on_duty && lastSign > 0 && todayISO(new Date(lastSign)) === today;
    const status = onDuty ? (ageSeconds !== null && ageSeconds <= LIVE_SECONDS ? 'live' : 'no_signal') : location ? 'off_duty' : 'never';
    counts[status]++;

    const mine = view.rows.filter((r) => r.deliveryBoyId === id && !['off', 'inactive', 'upcoming'].includes(r.kind));
    const next = mine.find((r) => r.kind === 'pending' || r.kind === 'missed');
    const last = entries.find((e) => String(e.delivery_boy_id) === id);
    return {
      id,
      name: b.name,
      mobile: b.mobile,
      routes: routes.filter((r) => String(r.boy_id) === id).map((r) => r.name),
      status,
      onDuty,
      dutyStartedAt: fromSqlDateTime(row?.duty_started_at),
      dutyEndedAt: fromSqlDateTime(row?.duty_ended_at),
      location,
      ageSeconds,
      progress: { total: mine.length, done: mine.filter((r) => r.entry).length },
      lastStop: last
        ? { customerId: last.customer_id, name: last.name, area: last.area, status: last.status, jars: CHARGED.includes(last.status) ? last.jars_delivered : 0, at: fromSqlDateTime(last.recorded_at) }
        : null,
      nextStop: next ? { customerId: next.customerId, name: next.name, area: next.area, location: pinBy.get(next.customerId) ?? null } : null,
    };
  });

  // Today's customers that have a map pin, coloured by their status in the admin map.
  const stops = view.rows
    .filter((r) => pinBy.has(r.customerId) && !['off', 'inactive', 'upcoming'].includes(r.kind))
    .map((r) => ({ customerId: r.customerId, name: r.name, area: r.area, kind: r.kind, deliveryBoyId: r.deliveryBoyId, location: pinBy.get(r.customerId) }));

  return { date: today, now: now.toISOString(), liveSeconds: LIVE_SECONDS, counts, deliveryBoys: list, stops };
}

/** Sum of the path, leaving out GPS jumps that would need more than ~150 km/h. */
function pathKm(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) {
    const d = distanceM(points[i - 1], points[i]);
    const secs = (Date.parse(points[i].at) - Date.parse(points[i - 1].at)) / 1000;
    if (secs > 0 && d / secs <= MAX_SPEED_MS) m += d;
  }
  return round(m / 1000, 2);
}

/** The path one delivery boy took on `date`, with the customers he marked along the way. */
export async function trail(boyId, date) {
  const boy = await db.one('SELECT id, name, mobile FROM delivery_boys WHERE id = ?', [boyId]);
  if (!boy) return null;
  const [rows, entries] = await Promise.all([
    db.q('SELECT lat, lng, accuracy, speed, recorded_at FROM location_points WHERE delivery_boy_id = ? AND date = ? ORDER BY recorded_at', [boy.id, date]),
    db.q(
      `SELECT e.customer_id, c.name, c.area, c.lat AS c_lat, c.lng AS c_lng, e.status, e.jars_delivered, e.empties_collected,
              e.recorded_at, e.lat, e.lng, e.location_accuracy
         FROM delivery_entries e JOIN customers c ON c.id = e.customer_id
        WHERE e.delivery_boy_id = ? AND e.date = ? ORDER BY e.recorded_at`,
      [boy.id, date],
    ),
  ]);
  const points = rows.map((r) => ({ lat: Number(r.lat), lng: Number(r.lng), accuracy: num(r.accuracy), speed: num(r.speed), at: fromSqlDateTime(r.recorded_at) }));
  return {
    date,
    deliveryBoy: { id: String(boy.id), name: boy.name, mobile: boy.mobile },
    points,
    distanceKm: pathKm(points),
    firstAt: points[0]?.at ?? null,
    lastAt: points.at(-1)?.at ?? null,
    entries: entries.map((e) => {
      const at = e.lat === null ? null : { lat: Number(e.lat), lng: Number(e.lng) };
      const pin = e.c_lat === null ? null : { lat: Number(e.c_lat), lng: Number(e.c_lng) };
      return {
        customerId: e.customer_id,
        name: e.name,
        area: e.area,
        status: e.status,
        jars: e.jars_delivered,
        empties: e.empties_collected,
        at: fromSqlDateTime(e.recorded_at),
        // Where the phone was when the entry was saved, and how far that is from the customer's pin.
        location: at ? { ...at, accuracy: num(e.location_accuracy) } : null,
        customerLocation: pin,
        distanceFromCustomerM: at && pin ? Math.round(distanceM(at, pin)) : null,
      };
    }),
  };
}
