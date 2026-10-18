import { createHash } from 'node:crypto';
import { tx } from './db.js';
import { HttpError } from './errors.js';

/**
 * Wraps a mutating handler so that repeating the same request (same user + Idempotency-Key header)
 * returns the stored response instead of doing the work twice.
 *
 * Everything (key claim, the business change, stored response) happens in ONE transaction:
 *  - parallel duplicates: the 2nd INSERT blocks on the unique key until the 1st commits, then sees the stored result;
 *  - if the handler throws (409/403/...), the key is rolled back too, so the client may retry freely.
 * handler(client) must return { status, body }.
 */
export async function runIdempotent(req, handler) {
  const key = req.get('Idempotency-Key');
  if (key && key.length > 200) throw new HttpError(400, 'Idempotency-Key too long');

  return tx(async (client) => {
    if (key) {
      const hash = createHash('sha256')
        .update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`).digest('hex');
      const claimed = await client.query(
        `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING 1`, [req.user.id, key, hash]);
      if (claimed.rowCount === 0) {
        const { rows: [prev] } = await client.query(
          'SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2',
          [req.user.id, key]);
        if (prev.request_hash !== hash) {
          throw new HttpError(422, 'Idempotency-Key was already used with a different request');
        }
        return { status: prev.status_code, body: prev.response, replay: true };
      }
      const result = await handler(client);
      await client.query('UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2',
        [req.user.id, key, result.status, JSON.stringify(result.body)]);
      return result;
    }
    return handler(client);
  });
}
