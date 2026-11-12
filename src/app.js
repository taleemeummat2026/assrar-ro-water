import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { db } from './db.js';
import { errorHandler, HttpError } from './lib/http.js';
import { rateLimit } from './lib/rateLimit.js';
import { uploadRoot } from './lib/uploads.js';
import { adminRouter } from './routes/admin/index.js';
import { authRouter } from './routes/auth.js';
import { customerRouter } from './routes/customer.js';
import { deliveryRouter } from './routes/delivery.js';
import { publicRouter, razorpayWebhook } from './routes/public.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Hostinger / Nginx
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  // The Android apps don't need CORS; the admin web app and website do.
  app.use(cors(config.corsOrigins ? { origin: config.corsOrigins } : undefined));
  // Razorpay webhook needs the exact raw body to verify its signature.
  app.post(['/v1/public/razorpay/webhook', '/public/razorpay/webhook'], express.raw({ type: '*/*', limit: '1mb' }), razorpayWebhook);
  app.use(express.json({ limit: '2mb' }));

  const strict = rateLimit({ windowMs: 60_000, max: config.isProduction ? 20 : 1000 });

  app.get('/health', async (_req, res) => {
    await db.one('SELECT 1 AS ok');
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // Same routes are served with and without the /v1 prefix.
  for (const base of ['/v1', '']) {
    app.use(`${base}/auth`, strict, authRouter);
    app.use(`${base}/public`, strict, publicRouter);
    app.use(`${base}/customer`, customerRouter);
    app.use(`${base}/delivery`, deliveryRouter);
    app.use(`${base}/admin`, adminRouter);
  }
  app.use('/uploads', express.static(uploadRoot, { maxAge: '7d', fallthrough: false }));

  app.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use(errorHandler);
  return app;
}
