import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { app, call, makeItem, pool, setup } from './helpers.js';
import { processJobs } from '../src/jobs.js';

let teams, users;
before(async () => ({ teams, users } = await setup()));
after(() => pool.end());

describe('concurrent claim', () => {
  it('only one of six simultaneous claims wins; the rest get 409', async () => {
    const item = await makeItem(users.lead, teams.A);
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => call(users[`m${i}`], 'POST', `/items/${item.id}/claim`)));
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409, 409, 409, 409, 409]);
    const winner = results.find((r) => r.status === 200).body.assignee_id;
    const { rows } = await pool.query('SELECT assignee_id, version FROM work_items WHERE id = $1', [item.id]);
    assert.equal(rows[0].assignee_id, winner);
    assert.equal(rows[0].version, 2); // exactly one change applied
    const { rows: ev } = await pool.query(`SELECT count(*)::int n FROM activity_events WHERE item_id = $1 AND kind = 'assignee_changed'`, [item.id]);
    assert.equal(ev[0].n, 1);
  });
});

describe('stale updates (optimistic locking)', () => {
  it('rejects an update made with an old version and leaves data unchanged', async () => {
    const item = await makeItem(users.m1, teams.A, { title: 'Original' });
    const ok = await call(users.m1, 'PATCH', `/items/${item.id}`, { version: 1, title: 'Edit by m1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.version, 2);
    const stale = await call(users.m2, 'PATCH', `/items/${item.id}`, { version: 1, title: 'Edit by m2 (stale)' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.version, 2);
    assert.equal(stale.body.current.title, 'Edit by m1');
    const { rows } = await pool.query('SELECT title FROM work_items WHERE id = $1', [item.id]);
    assert.equal(rows[0].title, 'Edit by m1');
  });

  it('two parallel edits from the same version: exactly one wins', async () => {
    const item = await makeItem(users.m1, teams.A);
    const rs = await Promise.all([users.m1, users.m2].map((u, i) => call(u, 'PATCH', `/items/${item.id}`, { version: 1, priority: i ? 'high' : 'low' })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  });
});

describe('idempotency', () => {
  it('same key twice creates ONE item and returns the same response', async () => {
    const h = { 'Idempotency-Key': 'create-1' };
    const body = { title: 'Idem item', team_id: teams.A };
    const a = await call(users.m1, 'POST', '/items', body, h);
    const b = await call(users.m1, 'POST', '/items', body, h);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.headers['idempotent-replay'], 'true');
    assert.equal(a.body.id, b.body.id);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM work_items WHERE title = 'Idem item'`);
    assert.equal(rows[0].n, 1);
  });

  it('five PARALLEL duplicates still create one item', async () => {
    const h = { 'Idempotency-Key': 'create-parallel' };
    const rs = await Promise.all(Array.from({ length: 5 }, () => call(users.m1, 'POST', '/items', { title: 'Parallel idem', team_id: teams.A }, h)));
    assert.ok(rs.every((r) => r.status === 201));
    assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM work_items WHERE title = 'Parallel idem'`);
    assert.equal(rows[0].n, 1);
  });

  it('reusing a key with a different payload is rejected', async () => {
    const h = { 'Idempotency-Key': 'create-2' };
    await call(users.m1, 'POST', '/items', { title: 'One', team_id: teams.A }, h);
    const r = await call(users.m1, 'POST', '/items', { title: 'Different', team_id: teams.A }, h);
    assert.equal(r.status, 422);
  });
});

describe('workflow rules', () => {
  it('rejects invalid jumps and enforces the lead-only approval step', async () => {
    const item = await makeItem(users.m1, teams.A);
    let v = item.version;
    const jump = await call(users.m1, 'POST', `/items/${item.id}/transition`, { to: 'closed', version: v });
    assert.equal(jump.status, 422);

    let r = await call(users.m1, 'POST', `/items/${item.id}/transition`, { to: 'in_progress', version: v });
    assert.equal(r.status, 200);
    assert.equal(r.body.assignee_id, users.m1.id); // starting work takes ownership
    r = await call(users.m1, 'POST', `/items/${item.id}/transition`, { to: 'awaiting_approval', version: r.body.version });
    assert.equal(r.status, 200);
    v = r.body.version;

    const memberApprove = await call(users.m1, 'POST', `/items/${item.id}/transition`, { to: 'resolved', version: v });
    assert.equal(memberApprove.status, 403);
    const otherMember = await call(users.m2, 'POST', `/items/${item.id}/transition`, { to: 'resolved', version: v });
    assert.equal(otherMember.status, 403);

    const approve = await call(users.lead, 'POST', `/items/${item.id}/transition`, { to: 'resolved', version: v });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.status, 'resolved');
  });

  it('a non-assignee member cannot move someone else\'s item', async () => {
    const item = await makeItem(users.m1, teams.A);
    await call(users.m1, 'POST', `/items/${item.id}/claim`);
    const r = await call(users.m2, 'POST', `/items/${item.id}/transition`, { to: 'in_progress', version: 2 });
    assert.equal(r.status, 403);
  });

  it('closed is terminal', async () => {
    const item = await makeItem(users.lead, teams.A);
    let v = item.version;
    for (const to of ['in_progress', 'awaiting_approval', 'resolved', 'closed']) {
      const r = await call(users.lead, 'POST', `/items/${item.id}/transition`, { to, version: v });
      assert.equal(r.status, 200, to);
      v = r.body.version;
    }
    const r = await call(users.lead, 'POST', `/items/${item.id}/transition`, { to: 'open', version: v });
    assert.equal(r.status, 422);
  });
});

describe('resource-level authorization', () => {
  it('a user from another team cannot read or write (404, existence not leaked)', async () => {
    const item = await makeItem(users.m1, teams.A);
    for (const [method, path, body] of [
      ['GET', `/items/${item.id}`], ['GET', `/items/${item.id}/activity`],
      ['PATCH', `/items/${item.id}`, { version: 1, title: 'hax' }], ['POST', `/items/${item.id}/claim`],
      ['POST', `/items/${item.id}/comments`, { text: 'hi' }], ['POST', `/items/${item.id}/transition`, { to: 'in_progress', version: 1 }],
    ]) {
      const r = await call(users.outsider, method, path, body);
      assert.equal(r.status, 404, `${method} ${path}`);
    }
    const list = await call(users.outsider, 'GET', '/items');
    assert.equal(list.body.items.length, 0);
    const create = await call(users.outsider, 'POST', '/items', { title: 'x', team_id: teams.A });
    assert.equal(create.status, 404);
  });

  it('a viewer can read but not create, comment, claim or edit (403)', async () => {
    const item = await makeItem(users.m1, teams.A);
    assert.equal((await call(users.viewer, 'GET', `/items/${item.id}`)).status, 200);
    assert.equal((await call(users.viewer, 'POST', '/items', { title: 'x', team_id: teams.A })).status, 403);
    assert.equal((await call(users.viewer, 'POST', `/items/${item.id}/comments`, { text: 'x' })).status, 403);
    assert.equal((await call(users.viewer, 'POST', `/items/${item.id}/claim`)).status, 403);
    assert.equal((await call(users.viewer, 'PATCH', `/items/${item.id}`, { version: 1, title: 'x' })).status, 403);
  });

  it('only leads can reassign; members can only release their own item', async () => {
    const item = await makeItem(users.m1, teams.A);
    const denied = await call(users.m1, 'PATCH', `/items/${item.id}`, { version: 1, assignee_id: users.m2.id });
    assert.equal(denied.status, 403);
    const ok = await call(users.lead, 'PATCH', `/items/${item.id}`, { version: 1, assignee_id: users.m2.id });
    assert.equal(ok.status, 200);
    const release = await call(users.m2, 'PATCH', `/items/${item.id}`, { version: 2, assignee_id: null });
    assert.equal(release.status, 200);
    const badAssignee = await call(users.lead, 'PATCH', `/items/${item.id}`, { version: 3, assignee_id: users.outsider.id });
    assert.equal(badAssignee.status, 422);
  });

  it('requires authentication', async () => {
    assert.equal((await request(app).get('/api/items')).status, 401);
    assert.equal((await request(app).get('/api/items').set('Authorization', 'Bearer nope')).status, 401);
  });
});

describe('history is consistent and append-only', () => {
  it('records owner, priority and state changes + comments, newest first', async () => {
    const item = await makeItem(users.m1, teams.A);
    await call(users.m1, 'POST', `/items/${item.id}/claim`);
    await call(users.m1, 'PATCH', `/items/${item.id}`, { version: 2, priority: 'urgent' });
    await call(users.m1, 'POST', `/items/${item.id}/transition`, { to: 'in_progress', version: 3 });
    await call(users.m2, 'POST', `/items/${item.id}/comments`, { text: 'looking too' });
    const r = await call(users.m1, 'GET', `/items/${item.id}/activity`);
    assert.deepEqual(r.body.events.map((e) => e.kind), ['comment', 'status_changed', 'priority_changed', 'assignee_changed', 'created']);
    assert.equal(r.body.events[0].actor_name, 'm2');
  });

  it('a failed change writes no history (same transaction)', async () => {
    const item = await makeItem(users.m1, teams.A);
    await call(users.m1, 'PATCH', `/items/${item.id}`, { version: 99, priority: 'high' }); // 409
    await call(users.m1, 'POST', `/items/${item.id}/transition`, { to: 'closed', version: 1 }); // 422
    const { rows } = await pool.query('SELECT count(*)::int n FROM activity_events WHERE item_id = $1', [item.id]);
    assert.equal(rows[0].n, 1); // only 'created'
  });

  it('database refuses to modify or delete events', async () => {
    const item = await makeItem(users.m1, teams.A);
    await assert.rejects(pool.query(`UPDATE activity_events SET kind = 'x' WHERE item_id = $1`, [item.id]), /append-only/);
    await assert.rejects(pool.query('DELETE FROM activity_events WHERE item_id = $1', [item.id]), /append-only/);
  });
});

describe('reliable async work (transactional outbox)', () => {
  it('assigning writes a job in the same transaction; worker delivers exactly one notification, even if re-run', async () => {
    await pool.query('TRUNCATE jobs, notifications RESTART IDENTITY');
    const item = await makeItem(users.m1, teams.A);
    await call(users.lead, 'PATCH', `/items/${item.id}`, { version: 1, assignee_id: users.m3.id });
    const { rows: jobs } = await pool.query(`SELECT * FROM jobs WHERE status = 'pending'`);
    assert.equal(jobs.length, 1);

    assert.equal(await processJobs(), 1);
    // simulate "worker crashed after doing the work but before marking done" -> job delivered again
    await pool.query(`UPDATE jobs SET status = 'pending' WHERE id = $1`, [jobs[0].id]);
    assert.equal(await processJobs(), 1);
    const { rows } = await pool.query('SELECT * FROM notifications WHERE user_id = $1', [users.m3.id]);
    assert.equal(rows.length, 1);
    const n = await call(users.m3, 'GET', '/notifications');
    assert.equal(n.body.unread, 1);
  });

  it('a rolled-back change leaves no job behind', async () => {
    await pool.query('TRUNCATE jobs RESTART IDENTITY');
    const item = await makeItem(users.m1, teams.A);
    await call(users.lead, 'PATCH', `/items/${item.id}`, { version: 42, assignee_id: users.m3.id }); // stale -> 409
    assert.equal((await pool.query('SELECT count(*)::int n FROM jobs')).rows[0].n, 0);
  });

  it('failing jobs retry with backoff, then are marked failed at max_attempts', async () => {
    await pool.query('TRUNCATE jobs RESTART IDENTITY');
    await pool.query(`INSERT INTO jobs (type, max_attempts) VALUES ('always_fails', 3)`);
    const handlers = { always_fails: async () => { throw new Error('boom'); } };
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(await processJobs({ handlers }), 1);
      const { rows: [j] } = await pool.query('SELECT * FROM jobs');
      assert.equal(j.attempts, attempt);
      assert.equal(j.status, attempt < 3 ? 'pending' : 'failed');
      if (attempt < 3) { // backoff pushed run_at into the future => not picked up immediately
        assert.equal(await processJobs({ handlers }), 0);
        await pool.query('UPDATE jobs SET run_at = now()');
      }
    }
    assert.equal(await processJobs({ handlers }), 0); // failed jobs are never retried
  });

  it('a partial failure inside a handler is rolled back', async () => {
    await pool.query('TRUNCATE jobs, notifications RESTART IDENTITY');
    const item = await makeItem(users.m1, teams.A);
    await pool.query(`INSERT INTO jobs (type, max_attempts) VALUES ('half_done', 1)`);
    const handlers = { half_done: async (c, job) => {
      await c.query(`INSERT INTO notifications (user_id, item_id, message, job_id) VALUES ($1, $2, 'partial', $3)`, [users.m1.id, item.id, job.id]);
      throw new Error('crash after partial work');
    } };
    await processJobs({ handlers });
    assert.equal((await pool.query('SELECT count(*)::int n FROM notifications')).rows[0].n, 0);
  });
});

describe('listing, filtering, pagination', () => {
  it('cursor pagination returns every item exactly once; filters and search run on the server', async () => {
    await pool.query('TRUNCATE activity_events, work_items RESTART IDENTITY CASCADE');
    for (let i = 1; i <= 25; i++) {
      await makeItem(users.m1, teams.A, { title: `Payment failure ${i}`, priority: i % 5 === 0 ? 'urgent' : 'low', type: i % 2 ? 'payment' : 'incident' });
    }
    await makeItem(users.outsider, teams.B, { title: 'Payment failure other team' });

    const seen = new Set();
    let cursor = null, pages = 0;
    do {
      const r = await call(users.m1, 'GET', `/items?limit=10${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200);
      r.body.items.forEach((it) => { assert.ok(!seen.has(it.id), 'duplicate across pages'); seen.add(it.id); });
      cursor = r.body.next_cursor; pages++;
    } while (cursor);
    assert.equal(seen.size, 25);          // other team's item never appears
    assert.equal(pages, 3);

    const urgent = await call(users.m1, 'GET', '/items?view=unassigned_urgent&limit=100');
    assert.equal(urgent.body.items.length, 5);
    const search = await call(users.m1, 'GET', '/items?q=payment%20fail&type=incident&limit=100');
    assert.equal(search.body.items.length, 12);
    const counts = await call(users.m1, 'GET', '/dashboard/counts');
    assert.equal(counts.body.unassigned_urgent, 5);
    assert.equal(counts.body.awaiting_my_approval, 0);
    assert.equal((await call(users.m1, 'GET', '/items?cursor=garbage')).status, 400);
  });

  it('"awaiting my approval" only shows for leads of that team', async () => {
    const item = await makeItem(users.m1, teams.A);
    await call(users.m1, 'POST', `/items/${item.id}/transition`, { to: 'in_progress', version: 1 });
    await call(users.m1, 'POST', `/items/${item.id}/transition`, { to: 'awaiting_approval', version: 2 });
    assert.equal((await call(users.lead, 'GET', '/items?view=awaiting_my_approval')).body.items.length, 1);
    assert.equal((await call(users.m2, 'GET', '/items?view=awaiting_my_approval')).body.items.length, 0);
  });
});

describe('login', () => {
  it('returns a token for valid credentials and 401 otherwise', async () => {
    const ok = await request(app).post('/api/auth/login').send({ email: 'lead@t.test', password: 'pw' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal((await request(app).post('/api/auth/login').send({ email: 'lead@t.test', password: 'wrong' })).status, 401);
    assert.equal((await request(app).post('/api/auth/login').send({ email: 'nobody@t.test', password: 'pw' })).status, 401);
  });
});
