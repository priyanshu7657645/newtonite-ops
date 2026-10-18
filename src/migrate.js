import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** Applies the schema under an advisory lock so app + worker can start together safely. */
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  console.log('[migrate] schema up to date');
  await pool.end();
}
