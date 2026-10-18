import { tx } from './db.js';

/**
 * Handlers must be IDEMPOTENT: delivery is at-least-once (a worker can crash after doing the work but before
 * marking the job done). UNIQUE(job_id, user_id) + ON CONFLICT DO NOTHING guarantees one notification per job+user.
 */
export const defaultHandlers = {
  async notify(c, job) {
    const { user_ids, item_id, message } = job.payload;
    for (const userId of user_ids) {
      await c.query(
        `INSERT INTO notifications (user_id, item_id, message, job_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (job_id, user_id) DO NOTHING`, [userId, item_id, message, job.id]);
    }
  },
};

/**
 * Drains due jobs. Each job runs in its own transaction with FOR UPDATE SKIP LOCKED, so several workers
 * can run side by side without picking the same job. If the process dies mid-job the transaction rolls back
 * and the job simply becomes visible again. Failures retry with exponential backoff up to max_attempts, then 'failed'.
 */
export async function processJobs({ handlers = defaultHandlers, maxJobs = 100 } = {}) {
  let processed = 0;
  while (processed < maxJobs) {
    const didWork = await tx(async (c) => {
      const { rows: [job] } = await c.query(
        `SELECT * FROM jobs WHERE status = 'pending' AND run_at <= now()
          ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!job) return false;
      try {
        await c.query('SAVEPOINT handler');
        const handler = handlers[job.type];
        if (!handler) throw new Error(`No handler for job type '${job.type}'`);
        await handler(c, job);
        await c.query(`UPDATE jobs SET status = 'done', attempts = attempts + 1, last_error = NULL WHERE id = $1`, [job.id]);
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT handler'); // undo any partial work of the failed attempt
        const attempts = job.attempts + 1;
        const giveUp = attempts >= job.max_attempts;
        await c.query(
          `UPDATE jobs SET attempts = $2, last_error = $3, status = $4,
                  run_at = now() + make_interval(secs => $5) WHERE id = $1`,
          [job.id, attempts, String(err.message).slice(0, 500), giveUp ? 'failed' : 'pending', Math.min(2 ** attempts, 300)]);
      }
      return true;
    });
    if (!didWork) break;
    processed++;
  }
  return processed;
}
