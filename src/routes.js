import { Router } from 'express';
import { authenticate, login } from './auth.js';
import { pool } from './db.js';
import { HttpError } from './errors.js';
import { runIdempotent } from './idempotency.js';
import * as items from './items.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const itemId = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'Not found');
  return id;
};
const send = (res, result) => {
  if (result.replay) res.set('Idempotent-Replay', 'true');
  res.status(result.status).json(result.body);
};

export const router = Router();

router.get('/health', wrap(async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));
router.post('/auth/login', wrap(async (req, res) => res.json(await login(req.body?.email, req.body?.password))));

router.use(authenticate); // everything below requires a valid token

router.get('/me', (req, res) => res.json({ id: req.user.id, name: req.user.name, email: req.user.email, teams: req.user.teams }));
router.get('/teams/:id/members', wrap(async (req, res) => res.json(await items.teamMembers(req.user, Number(req.params.id)))));

router.get('/dashboard/counts', wrap(async (req, res) => res.json(await items.dashboardCounts(req.user))));
router.get('/items', wrap(async (req, res) => res.json(await items.listItems(req.user, req.query))));
router.get('/items/:id', wrap(async (req, res) => res.json(await items.getItem(req.user, itemId(req)))));
router.get('/items/:id/activity', wrap(async (req, res) => res.json(await items.getActivity(req.user, itemId(req), req.query))));

// Mutations. POSTs accept an Idempotency-Key header.
router.post('/items', wrap(async (req, res) =>
  send(res, await runIdempotent(req, async (c) => ({ status: 201, body: await items.createItem(c, req.user, req.body ?? {}) })))));
router.patch('/items/:id', wrap(async (req, res) => {
  const id = itemId(req);
  send(res, await runIdempotent(req, async (c) => ({ status: 200, body: await items.updateItem(c, req.user, id, req.body ?? {}) })));
}));
router.post('/items/:id/claim', wrap(async (req, res) => {
  const id = itemId(req);
  send(res, await runIdempotent(req, async (c) => ({ status: 200, body: await items.claimItem(c, req.user, id) })));
}));
router.post('/items/:id/transition', wrap(async (req, res) => {
  const id = itemId(req);
  send(res, await runIdempotent(req, async (c) => ({ status: 200, body: await items.transitionItem(c, req.user, id, req.body ?? {}) })));
}));
router.post('/items/:id/comments', wrap(async (req, res) => {
  const id = itemId(req);
  send(res, await runIdempotent(req, (c) => items.addComment(c, req.user, id, req.body ?? {})));
}));

// Notifications produced by the background worker
router.get('/notifications', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, item_id, message, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [req.user.id]);
  res.json({ notifications: rows, unread: rows.filter((n) => !n.read_at).length });
}));
router.post('/notifications/read-all', wrap(async (req, res) => {
  await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));
