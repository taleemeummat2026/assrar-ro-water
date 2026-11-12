import bcrypt from 'bcryptjs';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { logActivity } from '../lib/activity.js';
import { signToken } from '../lib/auth.js';
import { toSqlDateTime } from '../lib/dates.js';
import { HttpError, parse, zMobile } from '../lib/http.js';
import { sendSms } from '../lib/sms.js';
import { getCustomerRow, mapCustomer } from '../services/data.js';

export const authRouter = Router();

const hashOtp = (mobile, code) => createHash('sha256').update(`${mobile}:${code}:${config.jwtSecret}`).digest('hex');
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* ---------------- Customer: mobile + OTP ---------------- */

authRouter.post('/customer/otp', async (req, res) => {
  const { mobile } = parse(z.object({ mobile: zMobile }), req.body);
  const customer = await db.one('SELECT id FROM customers WHERE mobile = ? AND active = 1', [mobile]);
  if (!customer) throw new HttpError(404, 'This mobile number is not registered with us. Request a new connection below.');

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
  const row = await db.one('SELECT id FROM customers WHERE mobile = ? AND active = 1', [mobile]);
  if (!row) throw new HttpError(404, 'This mobile number is not registered with us.');

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

  const customer = mapCustomer(await getCustomerRow(row.id));
  await logActivity({ type: 'customer', id: customer.id, name: customer.name }, 'customer.login', 'customer', customer.id);
  res.json({ token: signToken('customer', customer.id), customer });
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
