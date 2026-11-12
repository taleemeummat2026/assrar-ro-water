import bcrypt from 'bcryptjs';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { logActivity } from '../lib/activity.js';
import { requireSignup, signToken } from '../lib/auth.js';
import { createCustomer } from './admin/customers.js';
import { todayISO, toSqlDateTime } from '../lib/dates.js';
import { HttpError, parse, zDate, zMobile } from '../lib/http.js';
import { sendSms } from '../lib/sms.js';
import { getCustomerRow, mapCustomer } from '../services/data.js';

export const authRouter = Router();

const CLOSED = 'This connection is closed. Please call the office to start it again.';

const hashOtp = (mobile, code) => createHash('sha256').update(`${mobile}:${code}:${config.jwtSecret}`).digest('hex');
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* ---------------- Customer: mobile + OTP ---------------- */

authRouter.post('/customer/otp', async (req, res) => {
  const { mobile } = parse(z.object({ mobile: zMobile }), req.body);
  // Anyone can log in — new numbers fill in their details after the OTP. Only closed connections are stopped.
  const existing = await db.one('SELECT active, signup_status FROM customers WHERE mobile = ?', [mobile]);
  if (existing && !existing.active && existing.signup_status === 'approved') throw new HttpError(403, CLOSED);

  if (config.otp.testNumbers.has(mobile)) return res.json({ sent: true });

  const last = await db.one('SELECT sent_at FROM otp_codes WHERE mobile = ?', [mobile]);
  if (last && Date.now() - new Date(`${last.sent_at.replace(' ', 'T')}Z`).getTime() < config.otp.resendSeconds * 1000) {
    throw new HttpError(429, 'Please wait a few seconds before asking for a new OTP.');
  }

  const code = config.otp.fixedCode ?? String(randomInt(1000, 10000));
  const expires = new Date(Date.now() + config.otp.ttlMinutes * 60_000);
  await db.q(
    `INSERT INTO otp_codes (mobile, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
     ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), expires_at = VALUES(expires_at), attempts = 0, sent_at = VALUES(sent_at)`,
    [mobile, hashOtp(mobile, code), toSqlDateTime(expires), toSqlDateTime()],
  );
  // With a fixed test OTP nothing is sent (no SMS cost during testing).
  if (!config.otp.fixedCode) {
    await sendSms(mobile, `${code} is your OTP to log in to the water delivery app. It is valid for ${config.otp.ttlMinutes} minutes. Do not share it.`);
  }
  res.json({ sent: true });
});

authRouter.post('/customer/verify', async (req, res) => {
  const { mobile, otp } = parse(z.object({ mobile: zMobile, otp: z.string().trim().regex(/^\d{4,6}$/, 'Enter the OTP') }), req.body);
  const row = await db.one('SELECT id, active, signup_status FROM customers WHERE mobile = ?', [mobile]);
  if (row && !row.active && row.signup_status === 'approved') throw new HttpError(403, CLOSED);

  const testOtp = config.otp.testNumbers.get(mobile);
  if (testOtp) {
    if (otp !== testOtp) throw new HttpError(401, 'Wrong OTP. Please check and try again.');
  } else {
    const saved = await db.one('SELECT code_hash, expires_at, attempts FROM otp_codes WHERE mobile = ?', [mobile]);
    if (!saved) throw new HttpError(401, 'Please ask for a new OTP.');
    if (new Date(`${saved.expires_at.replace(' ', 'T')}Z`) < new Date()) throw new HttpError(401, 'This OTP has expired. Please ask for a new one.');
    if (saved.attempts >= config.otp.maxAttempts) throw new HttpError(429, 'Too many wrong tries. Please ask for a new OTP.');
    if (!sameHash(saved.code_hash, hashOtp(mobile, otp))) {
      await db.q('UPDATE otp_codes SET attempts = attempts + 1 WHERE mobile = ?', [mobile]);
      throw new HttpError(401, 'Wrong OTP. Please check and try again.');
    }
    await db.q('DELETE FROM otp_codes WHERE mobile = ?', [mobile]);
  }

  if (!row) {
    // New number: a short-lived token to fill in the sign-up details.
    return res.json({ token: signToken('signup', mobile), customer: null, isNew: true });
  }
  const customer = mapCustomer(await getCustomerRow(row.id));
  await logActivity({ type: 'customer', id: customer.id, name: customer.name }, 'customer.login', 'customer', customer.id);
  res.json({ token: signToken('customer', customer.id), customer, isNew: false });
});

const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(100),
  address: z.string().trim().min(5, 'Enter your full address').max(200),
  landmark: z.string().trim().max(80).optional(),
  area: z.string().trim().min(2, 'Choose your area').max(80),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  product: z.enum(['jar', 'camper']).default('jar'),
  jarsPerDay: z.coerce.number().int().min(1, 'At least 1 jar').max(20).default(1),
  schedule: z
    .object({ type: z.enum(['daily', 'alternate', 'weekdays']), days: z.array(z.number().int().min(0).max(6)).optional() })
    .refine((s) => s.type !== 'weekdays' || (s.days?.length ?? 0) > 0, 'Pick at least one delivery day')
    .default({ type: 'daily' }),
  startDate: zDate.optional(),
  notes: z.string().trim().max(500).optional(),
});

/** New customer fills in their details after the OTP → Customer ID now, deliveries after the office approves. */
authRouter.post('/customer/register', requireSignup, async (req, res) => {
  const input = parse(signupSchema, req.body);
  const mobile = req.signupMobile;
  if (await db.one('SELECT id FROM customers WHERE mobile = ?', [mobile])) throw new HttpError(409, 'This number is already registered. Please log in again.');
  const today = todayISO();
  const id = await createCustomer(
    {
      name: input.name,
      mobile,
      address: input.landmark ? `${input.address}, ${input.landmark}` : input.address,
      area: input.area,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      product: input.product,
      jarsPerDay: input.jarsPerDay,
      schedule: input.schedule,
      startDate: input.startDate && input.startDate > today ? input.startDate : today,
      notes: input.notes,
    },
    { type: 'customer', id: mobile, name: input.name },
    { pending: true },
  );
  const customer = mapCustomer(await getCustomerRow(id));
  res.status(201).json({ token: signToken('customer', id), customer });
});

/* ---------------- Delivery boy: mobile + password ---------------- */

authRouter.post('/delivery/login', async (req, res) => {
  const { mobile, password } = parse(z.object({ mobile: z.string().trim().regex(/^\d{10}$/, 'Enter your 10-digit mobile number'), password: z.string().min(1, 'Enter your password') }), req.body);
  const boy = await db.one('SELECT * FROM delivery_boys WHERE mobile = ? AND active = 1', [mobile]);
  if (!boy || !(await bcrypt.compare(password, boy.password_hash))) throw new HttpError(401, 'Wrong mobile number or password.');
  const routes = await db.q('SELECT id, name FROM routes WHERE delivery_boy_id = ? AND active = 1 ORDER BY sort_order, id', [boy.id]);
  await logActivity({ type: 'delivery', id: String(boy.id), name: boy.name }, 'delivery.login', 'delivery_boy', String(boy.id));
  res.json({
    token: signToken('delivery', boy.id),
    deliveryBoy: { id: String(boy.id), name: boy.name, mobile: boy.mobile, routes: routes.map((r) => ({ id: String(r.id), name: r.name })) },
  });
});

/* ---------------- Admin: mobile + password ---------------- */

authRouter.post('/admin/login', async (req, res) => {
  const { mobile, password } = parse(z.object({ mobile: z.string().trim().regex(/^\d{10}$/, 'Enter your 10-digit mobile number'), password: z.string().min(1, 'Enter your password') }), req.body);
  const admin = await db.one('SELECT * FROM admin_users WHERE mobile = ? AND active = 1', [mobile]);
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) throw new HttpError(401, 'Wrong mobile number or password.');
  await logActivity({ type: 'admin', id: String(admin.id), name: admin.name }, 'admin.login', 'admin_user', String(admin.id));
  res.json({ token: signToken('admin', admin.id), admin: { id: String(admin.id), name: admin.name, mobile: admin.mobile, role: admin.role } });
});
