// Test harness: uses a SEPARATE database (created on demand) and builds a tiny fixture per test file.
import bcrypt from 'bcryptjs';
import pg from 'pg';
import request from 'supertest';

const url = process.env.TEST_DATABASE_URL || 'postgres://ops:ops@localhost:5432/ops_test';
const dbName = new URL(url).pathname.slice(1);
if (!dbName.includes('test')) throw new Error(`Refusing to run tests against '${dbName}' - database name must contain 'test'`);

const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
await admin.end();

process.env.DATABASE_URL = url;
process.env.JWT_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { signToken } = await import('../src/auth.js');
export { pool };
export const app = createApp();

const hash = bcrypt.hashSync('pw', 4);

/** Fresh data. Teams: A (lead, 6 members, viewer) and B (outsider). */
export async function setup() {
  // Safe: the guard at the top guarantees this is a database whose name contains 'test'.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  const teams = {};
  for (const n of ['A', 'B']) teams[n] = (await pool.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [n])).rows[0].id;
  const users = {};
  const add = async (key, team, role) => {
    const u = (await pool.query('INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name', [key, `${key}@t.test`, hash])).rows[0];
    await pool.query('INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3)', [u.id, teams[team], role]);
    users[key] = { ...u, token: signToken(u) };
  };
  await add('lead', 'A', 'lead');
  for (let i = 1; i <= 6; i++) await add(`m${i}`, 'A', 'member');
  await add('viewer', 'A', 'viewer');
  await add('outsider', 'B', 'member');
  return { teams, users };
}

/** call(user, 'POST', '/items', body, { 'Idempotency-Key': 'x' }) */
export function call(user, method, path, body, headers = {}) {
  let r = request(app)[method.toLowerCase()](`/api${path}`).set('Authorization', `Bearer ${user.token}`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return body === undefined ? r : r.send(body);
}

export const makeItem = async (user, teamId, extra = {}) =>
  (await call(user, 'POST', '/items', { title: 'Test item', team_id: teamId, ...extra })).body;
