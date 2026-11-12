import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { startJobs } from './jobs.js';

const app = createApp();
const server = app.listen(config.port, (err) => {
  // Express 5 reports listen errors here (e.g. the port is already used by another copy of the API).
  if (err) {
    console.error(`Could not start on port ${config.port}: ${err.code === 'EADDRINUSE' ? 'the port is already in use — is the API already running?' : err.message}`);
    process.exit(1);
  }
  console.log(`Ashhar RO Water API listening on port ${config.port} (${config.isProduction ? 'production' : 'development'})`);
  if (config.otp.fixedCode) {
    console.warn(`⚠ TEST_OTP is on: every customer can log in with OTP ${config.otp.fixedCode}. Remove TEST_OTP from .env before launch.`);
  }
});
startJobs();

async function shutdown() {
  server.close();
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
