import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

function required(name, devDefault) {
  const value = env[name];
  if (value) return value;
  if (isProduction) throw new Error(`Missing ${name} in .env`);
  return devDefault;
}

/** Test numbers that always accept a fixed OTP, e.g. for the Play Store reviewer: "9876500001:123456,9000000000:111111". */
function parseTestNumbers(raw) {
  const map = new Map();
  for (const pair of (raw ?? '').split(',')) {
    const [mobile, otp] = pair.split(':').map((s) => s?.trim());
    if (mobile && otp) map.set(mobile, otp);
  }
  return map;
}

export const config = {
  isProduction,
  port: Number(env.PORT ?? 4000),
  publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
  timeZone: env.APP_TIMEZONE ?? 'Asia/Kolkata',
  corsOrigins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((s) => s.trim()) : null,

  db: {
    host: env.DB_HOST ?? '127.0.0.1',
    port: Number(env.DB_PORT ?? 3306),
    user: env.DB_USER ?? 'root',
    password: env.DB_PASSWORD ?? '',
    database: env.DB_NAME ?? 'ashhar_ro_water',
    connectionLimit: Number(env.DB_CONNECTION_LIMIT ?? 10),
  },

  jwtSecret: required('JWT_SECRET', 'dev-only-secret-change-me'),
  tokenDays: { customer: 90, delivery: 30, admin: 1, signup: 1 },

  otp: {
    // TEST_OTP=1234 → every customer logs in with 1234 and no SMS is sent (testing phase only — remove before launch).
    fixedCode: /^\d{4}$/.test(env.TEST_OTP ?? '') ? env.TEST_OTP : null,
    testNumbers: parseTestNumbers(env.OTP_TEST_NUMBERS),
    ttlMinutes: 5,
    resendSeconds: 30,
    maxAttempts: 5,
  },

  sms: {
    // 'console' prints messages (development). 'http' calls SMS_URL_TEMPLATE with {mobile} and {message}.
    provider: env.SMS_PROVIDER ?? 'console',
    urlTemplate: env.SMS_URL_TEMPLATE ?? '',
    method: (env.SMS_HTTP_METHOD ?? 'GET').toUpperCase(),
  },

  // Razorpay (Dashboard → Account & Settings → API Keys / Webhooks). Empty = online payment hidden in the app.
  razorpay: {
    keyId: env.RAZORPAY_KEY_ID ?? '',
    keySecret: env.RAZORPAY_KEY_SECRET ?? '',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? '',
  },

  // Push notifications via Expo (PUSH_ENABLED=false turns them off; EXPO_ACCESS_TOKEN only if 'enhanced security' is on).
  push: {
    enabled: env.PUSH_ENABLED ? env.PUSH_ENABLED === 'true' : env.NODE_ENV !== 'test',
    accessToken: env.EXPO_ACCESS_TOKEN ?? '',
  },

  uploadDir: env.UPLOAD_DIR ?? 'uploads',
  backups: {
    enabled: env.BACKUP_ENABLED !== 'false',
    dir: env.BACKUP_DIR ?? 'backups',
    keepDays: Number(env.BACKUP_KEEP_DAYS ?? 14),
  },
  jobsEnabled: env.JOBS_ENABLED !== 'false',
};
