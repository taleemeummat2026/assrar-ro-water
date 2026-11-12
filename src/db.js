import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  charset: 'utf8mb4',
  timezone: 'Z', // DATETIME columns hold UTC
  dateStrings: true, // DATE stays 'YYYY-MM-DD', never shifted by time zones
  decimalNumbers: true,
});

// Timestamps are stored in UTC whatever the server's own time zone is.
pool.pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

/** Small query helpers bound to the pool or to one transaction connection. */
function helpers(executor, hooks = null) {
  return {
    /** Runs `fn` after the transaction is saved (right away outside a transaction). */
    onCommit(fn) {
      if (hooks) hooks.push(fn);
      else Promise.resolve().then(fn).catch(() => undefined);
    },
    async q(sql, params = []) {
      const [rows] = await executor.query(sql, params);
      return rows;
    },
    async one(sql, params = []) {
      const [rows] = await executor.query(sql, params);
      return rows[0] ?? null;
    },
  };
}

export const db = helpers(pool);

/** Runs `fn` inside a transaction. `fn` gets the same helpers (q, one) bound to the transaction. */
export async function tx(fn) {
  const conn = await pool.getConnection();
  const hooks = [];
  try {
    await conn.beginTransaction();
    const result = await fn(helpers(conn, hooks));
    await conn.commit();
    for (const h of hooks) Promise.resolve().then(h).catch(() => undefined);
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
