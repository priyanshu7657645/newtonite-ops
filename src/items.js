import { pool } from './db.js';
import { HttpError } from './errors.js';
import { authorize, hasRole, leadTeamIds, rank } from './permissions.js';
import { PRIORITIES, STATUSES, TYPES, allowedTransitions, transitionProblem } from './workflow.js';

const COLS = `w.id, w.title, w.description, w.type, w.priority, w.status, w.team_id, w.assignee_id,
  w.created_by, w.due_date, w.version, w.created_at, w.updated_at`;
const JOINED = `${COLS}, t.name AS team_name, a.name AS assignee_name, c.name AS created_by_name`;
const FROM = `FROM work_items w JOIN teams t ON t.id = w.team_id
  LEFT JOIN users a ON a.id = w.assignee_id JOIN users c ON c.id = w.created_by`;

/* ---------- validation ---------- */
const bad = (msg) => new HttpError(400, msg);

function cleanField(field, v) {
  switch (field) {
    case 'title': {
      if (typeof v !== 'string' || !v.trim() || v.trim().length > 200) throw bad('title must be 1-200 characters');
      return v.trim();
    }
    case 'description': {
      if (v == null) return '';
      if (typeof v !== 'string' || v.length > 5000) throw bad('description must be at most 5000 characters');
      return v;
    }
    case 'type': if (!TYPES.includes(v)) throw bad(`type must be one of ${TYPES.join(', ')}`); return v;
    case 'priority': if (!PRIORITIES.includes(v)) throw bad(`priority must be one of ${PRIORITIES.join(', ')}`); return v;
    case 'due_date': {
      if (v == null || v === '') return null;
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad('due_date must be YYYY-MM-DD');
      return v;
    }
    case 'assignee_id': {
      if (v == null || v === '') return null;
      if (!Number.isInteger(v) || v < 1) throw bad('assignee_id must be an integer or null');
      return v;
    }
    default: throw bad(`Unknown field ${field}`);
  }
}

const requireVersion = (v) => {
  if (!Number.isInteger(v) || v < 1) throw bad('version (integer) is required - send the version you last saw');
  return v;
};

/* ---------- helpers ---------- */
async function addEvent(c, itemId, actorId, kind, data = {}) {
  await c.query('INSERT INTO activity_events (item_id, actor_id, kind, data) VALUES ($1, $2, $3, $4)',
    [itemId, actorId, kind, JSON.stringify(data)]);
}

/** Outbox: written in the same transaction as the change, processed later by the worker. */
async function enqueueNotify(c, userIds, itemId, message) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return;
  await c.query('INSERT INTO jobs (type, payload) VALUES ($1, $2)', ['notify', JSON.stringify({ user_ids: ids, item_id: itemId, message })]);
}

async function lockItem(c, id) {
  const { rows } = await c.query('SELECT * FROM work_items WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new HttpError(404, 'Not found');
  return rows[0];
}

async function readItem(c, id) {
  const { rows } = await c.query(`SELECT ${JOINED} ${FROM} WHERE w.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Not found');
  return rows[0];
}

/** Adds what the current user may do, so the UI never has to guess (the server still re-checks everything). */
function describe(item, user) {
  const role = user.memberships.get(item.team_id);
  return {
    ...item,
    my_role: role,
    can: {
      edit: hasRole(role, 'edit') && item.status !== 'closed',
      comment: hasRole(role, 'comment'),
      claim: hasRole(role, 'claim') && item.assignee_id == null && ['open', 'in_progress'].includes(item.status),
      reassign: hasRole(role, 'reassign') && item.status !== 'closed',
      release: item.assignee_id != null && (item.assignee_id === user.id || hasRole(role, 'reassign')) && item.status !== 'closed',
      transitions: allowedTransitions(item, user, role),
    },
  };
}

/* ---------- commands ---------- */
export async function createItem(c, user, body) {
  const teamId = Number(body.team_id);
  if (!Number.isInteger(teamId)) throw bad('team_id is required');
  authorize(user, teamId, 'create');
  const row = {
    title: cleanField('title', body.title),
    description: cleanField('description', body.description),
    type: cleanField('type', body.type ?? 'task'),
    priority: cleanField('priority', body.priority ?? 'medium'),
    due_date: cleanField('due_date', body.due_date),
  };
  const { rows: [{ id }] } = await c.query(
    `INSERT INTO work_items (title, description, type, priority, team_id, created_by, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [row.title, row.description, row.type, row.priority, teamId, user.id, row.due_date]);
  await addEvent(c, id, user.id, 'created', { title: row.title, type: row.type, priority: row.priority });
  return describe(await readItem(c, id), user);
}

/**
 * Atomic claim. A single conditional UPDATE decides the winner:
 * the second concurrent UPDATE waits for the row lock, re-checks `assignee_id IS NULL`, matches 0 rows -> 409.
 */
export async function claimItem(c, user, id) {
  const { rows: [item] } = await c.query('SELECT id, team_id, status FROM work_items WHERE id = $1', [id]);
  if (!item) throw new HttpError(404, 'Not found');
  authorize(user, item.team_id, 'claim');
  const res = await c.query(
    `UPDATE work_items SET assignee_id = $1, version = version + 1, updated_at = now()
      WHERE id = $2 AND assignee_id IS NULL AND status IN ('open', 'in_progress')`, [user.id, id]);
  if (res.rowCount === 0) {
    const current = describe(await readItem(c, id), user);
    if (current.assignee_id != null) throw new HttpError(409, `Already claimed by ${current.assignee_name}`, { current });
    throw new HttpError(422, `Items in status '${current.status}' cannot be claimed`, { current });
  }
  await addEvent(c, id, user.id, 'assignee_changed', { from: null, to: user.id, to_name: user.name, via: 'claim' });
  return describe(await readItem(c, id), user);
}

/** Optimistic locking: the client sends the version it saw; a mismatch returns 409 + the latest item. */
export async function updateItem(c, user, id, body) {
  const version = requireVersion(body.version);
  const row = await lockItem(c, id);
  const role = authorize(user, row.team_id, 'edit');
  if (row.status === 'closed') throw new HttpError(422, 'Closed items are read-only');
  if (row.version !== version) {
    throw new HttpError(409, 'This item was changed by someone else', { current: describe(await readItem(c, id), user) });
  }

  const changes = {};
  for (const field of ['title', 'description', 'type', 'priority', 'due_date', 'assignee_id']) {
    if (!(field in body)) continue;
    const value = cleanField(field, body[field]);
    if (value !== row[field]) changes[field] = value;
  }
  if (!Object.keys(changes).length) return describe(await readItem(c, id), user);

  if ('assignee_id' in changes) {
    const releasing = changes.assignee_id === null && row.assignee_id === user.id;
    if (!hasRole(role, 'reassign') && !releasing) throw new HttpError(403, 'Only leads can reassign an item');
    if (changes.assignee_id !== null) {
      const { rows } = await c.query('SELECT role FROM memberships WHERE team_id = $1 AND user_id = $2', [row.team_id, changes.assignee_id]);
      if (!rows[0] || rank(rows[0].role) < rank('member')) throw new HttpError(422, 'Assignee must be a (non-viewer) member of the item\'s team');
    }
  }

  const fields = Object.keys(changes); // whitelisted above, safe to interpolate as column names
  await c.query(
    `UPDATE work_items SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`,
    [id, ...fields.map((f) => changes[f])]);

  if ('priority' in changes) await addEvent(c, id, user.id, 'priority_changed', { from: row.priority, to: changes.priority });
  if ('assignee_id' in changes) {
    const { rows: [to] } = changes.assignee_id ? await c.query('SELECT name FROM users WHERE id = $1', [changes.assignee_id]) : { rows: [{ name: null }] };
    await addEvent(c, id, user.id, 'assignee_changed', { from: row.assignee_id, to: changes.assignee_id, to_name: to.name, via: 'edit' });
    if (changes.assignee_id && changes.assignee_id !== user.id) {
      await enqueueNotify(c, [changes.assignee_id], id, `${user.name} assigned you: ${row.title}`);
    }
  }
  const edited = fields.filter((f) => f !== 'priority' && f !== 'assignee_id');
  if (edited.length) {
    await addEvent(c, id, user.id, 'edited', Object.fromEntries(edited.map((f) => [f, { from: row[f], to: changes[f] }])));
  }
  return describe(await readItem(c, id), user);
}

export async function transitionItem(c, user, id, body) {
  const version = requireVersion(body.version);
  const to = body.to;
  if (!STATUSES.includes(to)) throw bad(`to must be one of ${STATUSES.join(', ')}`);
  const row = await lockItem(c, id);
  const role = authorize(user, row.team_id, 'transition');
  if (row.version !== version) {
    throw new HttpError(409, 'This item was changed by someone else', { current: describe(await readItem(c, id), user) });
  }
  const problem = transitionProblem(row, to, user, role);
  if (problem) throw problem;

  const takesOwnership = row.status === 'open' && to === 'in_progress' && row.assignee_id == null;
  await c.query(
    `UPDATE work_items SET status = $2, assignee_id = CASE WHEN $3 THEN $4::int ELSE assignee_id END,
            version = version + 1, updated_at = now() WHERE id = $1`, [id, to, takesOwnership, user.id]);
  await addEvent(c, id, user.id, 'status_changed', { from: row.status, to, comment: body.comment ? String(body.comment).slice(0, 1000) : undefined });
  if (takesOwnership) await addEvent(c, id, user.id, 'assignee_changed', { from: null, to: user.id, to_name: user.name, via: 'start' });

  if (to === 'awaiting_approval') {
    const { rows } = await c.query(`SELECT user_id FROM memberships WHERE team_id = $1 AND role IN ('lead','admin') AND user_id <> $2`, [row.team_id, user.id]);
    await enqueueNotify(c, rows.map((r) => r.user_id), id, `Approval needed: ${row.title}`);
  } else if (row.assignee_id && row.assignee_id !== user.id) {
    await enqueueNotify(c, [row.assignee_id], id, `${user.name} moved "${row.title}" to ${to.replace('_', ' ')}`);
  }
  return describe(await readItem(c, id), user);
}

export async function addComment(c, user, id, body) {
  const { rows: [item] } = await c.query('SELECT id, team_id FROM work_items WHERE id = $1', [id]);
  if (!item) throw new HttpError(404, 'Not found');
  authorize(user, item.team_id, 'comment');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 2000) throw bad('text must be 1-2000 characters');
  await addEvent(c, id, user.id, 'comment', { text });
  await c.query('UPDATE work_items SET updated_at = now() WHERE id = $1', [id]); // surfaces activity; does NOT bump version
  return { status: 201, body: { ok: true } };
}

/* ---------- queries ---------- */
export async function getItem(user, id) {
  const item = await readItem(pool, id);
  authorize(user, item.team_id, 'view');
  return describe(item, user);
}

export async function getActivity(user, id, query) {
  const { rows: [item] } = await pool.query('SELECT team_id FROM work_items WHERE id = $1', [id]);
  if (!item) throw new HttpError(404, 'Not found');
  authorize(user, item.team_id, 'view');
  const limit = Math.min(Math.max(parseInt(query.limit) || 50, 1), 200);
  const params = [id];
  let cursor = '';
  if (query.cursor) {
    const before = Number(query.cursor);
    if (!Number.isInteger(before)) throw bad('invalid cursor');
    params.push(before);
    cursor = 'AND e.id < $2';
  }
  const { rows } = await pool.query(
    `SELECT e.id, e.kind, e.data, e.created_at, e.actor_id, u.name AS actor_name
       FROM activity_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.item_id = $1 ${cursor} ORDER BY e.id DESC LIMIT ${limit + 1}`, params);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  return { events: rows, next_cursor: hasMore ? String(rows[rows.length - 1].id) : null };
}

/** Dashboard views. Each maps to a partial index in schema.sql. */
function viewClause(view, user, p) {
  switch (view) {
    case 'assigned_to_me': return `w.assignee_id = ${p(user.id)} AND w.status NOT IN ('resolved','closed')`;
    case 'unassigned_urgent': return `w.assignee_id IS NULL AND w.priority = 'urgent' AND w.status IN ('open','in_progress')`;
    case 'awaiting_my_approval': return `w.status = 'awaiting_approval' AND w.team_id = ANY(${p(leadTeamIds(user))}::int[])`;
    default: throw bad('unknown view');
  }
}

export async function listItems(user, q) {
  const limit = Math.min(Math.max(parseInt(q.limit) || 25, 1), 100);
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  // Resource-level scoping: a user can only ever see items of their own teams.
  const where = [`w.team_id = ANY(${p([...user.memberships.keys()])}::int[])`];

  if (q.view) where.push(viewClause(q.view, user, p));
  if (q.status) { if (!STATUSES.includes(q.status)) throw bad('invalid status'); where.push(`w.status = ${p(q.status)}`); }
  if (q.priority) { if (!PRIORITIES.includes(q.priority)) throw bad('invalid priority'); where.push(`w.priority = ${p(q.priority)}`); }
  if (q.type) { if (!TYPES.includes(q.type)) throw bad('invalid type'); where.push(`w.type = ${p(q.type)}`); }
  if (q.team_id) { const t = Number(q.team_id); if (!Number.isInteger(t)) throw bad('invalid team_id'); where.push(`w.team_id = ${p(t)}`); }
  if (q.assignee === 'me') where.push(`w.assignee_id = ${p(user.id)}`);
  else if (q.assignee === 'unassigned') where.push('w.assignee_id IS NULL');
  else if (q.assignee) { const a = Number(q.assignee); if (!Number.isInteger(a)) throw bad('invalid assignee'); where.push(`w.assignee_id = ${p(a)}`); }
  if (q.q && String(q.q).trim()) {
    // Prefix full-text search. Tokens are letters/digits only, so the tsquery string is safe by construction.
    const tokens = String(q.q).match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
    if (tokens.length) where.push(`w.search @@ to_tsquery('simple', ${p(tokens.map((t) => `${t}:*`).join(' & '))})`);
  }
  if (q.cursor) {
    let decoded;
    try { decoded = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString()); } catch { throw bad('invalid cursor'); }
    if (!Array.isArray(decoded) || typeof decoded[0] !== 'string' || !Number.isInteger(decoded[1])) throw bad('invalid cursor');
    where.push(`(w.updated_at, w.id) < (${p(decoded[0])}::timestamptz, ${p(decoded[1])}::bigint)`);
  }

  // Keyset (cursor) pagination on (updated_at, id): stable and O(log n) deep into the list, unlike OFFSET.
  const { rows } = await pool.query(
    `SELECT ${JOINED}, w.updated_at::text AS cursor_ts ${FROM}
      WHERE ${where.join(' AND ')} ORDER BY w.updated_at DESC, w.id DESC LIMIT ${limit + 1}`, params);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows[rows.length - 1];
  const next_cursor = hasMore ? Buffer.from(JSON.stringify([last.cursor_ts, last.id])).toString('base64url') : null;
  return { items: rows.map(({ cursor_ts, ...item }) => item), next_cursor };
}

export async function dashboardCounts(user) {
  const out = {};
  await Promise.all(['assigned_to_me', 'unassigned_urgent', 'awaiting_my_approval'].map(async (view) => {
    const params = [];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    const base = `w.team_id = ANY(${p([...user.memberships.keys()])}::int[])`;
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM work_items w WHERE ${base} AND ${viewClause(view, user, p)}`, params);
    out[view] = rows[0].n;
  }));
  return out;
}

export async function teamMembers(user, teamId) {
  authorize(user, teamId, 'view');
  const { rows } = await pool.query(
    `SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = $1 ORDER BY u.name`, [teamId]);
  return rows;
}
