import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './db.js';
import { migrate } from './migrate.js';

export const DEMO_PASSWORD = 'password123';
const TEAMS = ['Support', 'Engineering', 'Payments', 'Compliance'];
// [name, email, { team: role }]
const USERS = [
  ['Alice Admin',   'alice@demo.test', { Support: 'admin', Engineering: 'admin', Payments: 'admin', Compliance: 'admin' }],
  ['Bob Lead',      'bob@demo.test',   { Support: 'lead', Engineering: 'member' }],
  ['Carol Lead',    'carol@demo.test', { Engineering: 'lead' }],
  ['Dave Lead',     'dave@demo.test',  { Payments: 'lead' }],
  ['Erin Lead',     'erin@demo.test',  { Compliance: 'lead', Payments: 'member' }],
  ['Frank Member',  'frank@demo.test', { Support: 'member' }],
  ['Grace Member',  'grace@demo.test', { Engineering: 'member' }],
  ['Heidi Member',  'heidi@demo.test', { Payments: 'member', Compliance: 'member' }],
  ['Ivan Viewer',   'ivan@demo.test',  { Support: 'viewer', Engineering: 'viewer' }],
  ['Judy Member',   'judy@demo.test',  { Support: 'member', Payments: 'member' }],
];
const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'];
const SUBJECTS = {
  incident: ['API latency spike', 'Checkout 500 errors', 'Database failover', 'Login outage in EU', 'Queue backlog growing'],
  customer_issue: ['Customer cannot reset password', 'Wrong invoice sent', 'Refund not received', 'Account locked', 'Missing order confirmation'],
  payment: ['Payout stuck pending', 'Duplicate charge reported', 'Chargeback review', 'Settlement mismatch', 'Card declined unexpectedly'],
  compliance: ['KYC document review', 'GDPR data request', 'Audit evidence request', 'Sanctions screening alert', 'Policy exception approval'],
  task: ['Rotate API keys', 'Update runbook', 'Onboard new vendor', 'Clean up stale accounts', 'Prepare monthly report'],
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const weighted = (pairs) => { let r = Math.random() * pairs.reduce((s, [, w]) => s + w, 0); for (const [v, w] of pairs) if ((r -= w) < 0) return v; return pairs[0][0]; };

export async function seed({ items = 5000 } = {}) {
  await migrate();
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (n > 0) { console.log('[seed] data already present, skipping'); return; }

  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const members = {}; // teamId -> [userId...] (non-viewers)
  await tx(async (c) => {
    const teamIds = {};
    for (const name of TEAMS) {
      teamIds[name] = (await c.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
      members[teamIds[name]] = [];
    }
    for (const [name, email, roles] of USERS) {
      const uid = (await c.query('INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id', [name, email, hash])).rows[0].id;
      for (const [team, role] of Object.entries(roles)) {
        await c.query('INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3)', [uid, teamIds[team], role]);
        if (role !== 'viewer') members[teamIds[team]].push(uid);
      }
    }
  });

  const teamIds = Object.keys(members).map(Number);
  for (let done = 0; done < items; done += 1000) {
    const cols = { t: [], d: [], ty: [], p: [], s: [], tm: [], a: [], cb: [], dd: [], ca: [] };
    for (let i = 0; i < Math.min(1000, items - done); i++) {
      const type = pick(TYPES), team = pick(teamIds);
      const status = weighted([['open', 30], ['in_progress', 30], ['awaiting_approval', 10], ['resolved', 15], ['closed', 15]]);
      const assigned = status === 'open' ? Math.random() < 0.4 : true;
      const created = new Date(Date.now() - Math.random() * 90 * 86400000);
      cols.t.push(`${pick(SUBJECTS[type])} #${done + i + 1}`);
      cols.d.push(`Auto-generated sample ${type.replace('_', ' ')} for load testing and demos.`);
      cols.ty.push(type);
      cols.p.push(weighted([['low', 25], ['medium', 40], ['high', 25], ['urgent', 10]]));
      cols.s.push(status);
      cols.tm.push(team);
      cols.a.push(assigned ? pick(members[team]) : null);
      cols.cb.push(pick(members[team]));
      cols.dd.push(Math.random() < 0.5 ? new Date(created.getTime() + (1 + Math.random() * 14) * 86400000).toISOString().slice(0, 10) : null);
      cols.ca.push(created.toISOString());
    }
    await pool.query(
      `INSERT INTO work_items (title, description, type, priority, status, team_id, assignee_id, created_by, due_date, created_at, updated_at)
       SELECT t, d, ty, p, s, tm, a, cb, dd, ca, ca
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[], $9::date[], $10::timestamptz[])
              AS x(t, d, ty, p, s, tm, a, cb, dd, ca)`,
      [cols.t, cols.d, cols.ty, cols.p, cols.s, cols.tm, cols.a, cols.cb, cols.dd, cols.ca]);
  }
  await pool.query(`INSERT INTO activity_events (item_id, actor_id, kind, data, created_at)
                    SELECT id, created_by, 'created', jsonb_build_object('title', title), created_at FROM work_items`);
  await pool.query('ANALYZE');
  console.log(`[seed] ${TEAMS.length} teams, ${USERS.length} users, ${items} items. Demo password: ${DEMO_PASSWORD}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await seed({ items: Number(process.env.SEED_ITEMS || 5000) });
  await pool.end();
}
