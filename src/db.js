import pg from 'pg';
import { config } from './config.js';

pg.types.setTypeParser(20, Number);        // bigint -> number (ids stay far below 2^53)
pg.types.setTypeParser(1082, (v) => v);    // date   -> 'YYYY-MM-DD' string (no timezone surprises)

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

/** Run fn inside one transaction. Any throw rolls everything back. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    throw err;
  } finally {
    client.release();
  }
}
