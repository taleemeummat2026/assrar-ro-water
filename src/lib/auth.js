import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db.js';
import { HttpError } from './http.js';

/** Token for a customer ('RO-0001'), delivery boy (numeric id) or admin user. */
export function signToken(role, id, extra = {}) {
  return jwt.sign({ role, ...extra }, config.jwtSecret, { subject: String(id), expiresIn: `${config.tokenDays[role]}d` });
}

function readToken(req) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Please log in.');
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    throw new HttpError(401, 'Your session has expired. Please log in again.');
  }
}

/** Logged-in, active customer → req.customerId */
export async function requireCustomer(req, _res, next) {
  const t = readToken(req);
  if (t.role !== 'customer') throw new HttpError(401, 'Please log in again.');
  const row = await db.one('SELECT id, name, active, signup_status FROM customers WHERE id = ?', [t.sub]);
  // New sign-ups (pending / not approved) may log in to see their status; closed connections may not.
  if (!row || (!row.active && row.signup_status === 'approved')) throw new HttpError(401, 'Your connection is not active. Please contact the office.');
  req.customerId = row.id;
  req.customerStatus = row.signup_status === 'approved' ? 'active' : row.signup_status;
  req.actor = { type: 'customer', id: row.id, name: row.name };
  next();
}

/** Logged-in, active delivery boy → req.boy */
export async function requireDelivery(req, _res, next) {
  const t = readToken(req);
  if (t.role !== 'delivery') throw new HttpError(401, 'Please log in again.');
  const row = await db.one('SELECT id, name, mobile FROM delivery_boys WHERE id = ? AND active = 1', [t.sub]);
  if (!row) throw new HttpError(401, 'Your account is not active. Please contact the office.');
  req.boy = row;
  req.actor = { type: 'delivery', id: String(row.id), name: row.name };
  next();
}

/**
 * Logged-in admin with one of `roles` (Owner can do everything).
 *   owner    – everything, incl. admin users and company profile
 *   manager  – customers, routes, delivery boys, entries, requests, payments, reports
 *   accounts – payments, bills, reports (read customers)
 */
export function requireAdmin(...roles) {
  return async (req, _res, next) => {
    const t = readToken(req);
    if (t.role !== 'admin') throw new HttpError(401, 'Please log in again.');
    const row = await db.one('SELECT id, name, mobile, role FROM admin_users WHERE id = ? AND active = 1', [t.sub]);
    if (!row) throw new HttpError(401, 'Your account is not active.');
    // requireAdmin() with no roles = Owner only.
    if (row.role !== 'owner' && !roles.includes(row.role)) {
      throw new HttpError(403, 'You do not have permission for this.');
    }
    req.admin = row;
    req.actor = { type: 'admin', id: String(row.id), name: row.name };
    next();
  };
}

/** OTP checked for a mobile number that is not a customer yet → it may register (req.signupMobile). */
export function requireSignup(req, _res, next) {
  const t = readToken(req);
  if (t.role !== 'signup') throw new HttpError(401, 'Please log in again.');
  req.signupMobile = t.sub;
  next();
}

/** Ordering, requests and payments need an approved connection. */
export function ensureApproved(req) {
  if (req.customerStatus !== 'active') throw new HttpError(403, 'Your connection is waiting for approval from the office.');
}
