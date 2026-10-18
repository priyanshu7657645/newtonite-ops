import { pool } from './db.js';
import { processJobs } from './jobs.js';
import { migrate } from './migrate.js';

await migrate();
console.log('[worker] started');
let running = true;
const stop = () => { running = false; };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

while (running) {
  try {
    const n = await processJobs();
    if (n) console.log(`[worker] processed ${n} job(s)`);
  } catch (err) {
    console.error('[worker] loop error (db down?) - will retry:', err.message);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
await pool.end();
