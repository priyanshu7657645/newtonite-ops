import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './errors.js';

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10); // equalises timing for unknown emails

export const signToken = (user) => jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: '8h' });

export async function login(email, password) {
  const { rows } = await pool.query('SELECT id, name, email, password_hash FROM users WHERE email = lower($1)', [String(email ?? '')]);
  const user = rows[0];
  const ok = await bcrypt.compare(String(password ?? ''), user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Invalid email or password');
  return { token: signToken(user), user: { id: user.id, name: user.name, email: user.email } };
}

/** Loads the user AND their team roles from the DB on every request, so role changes apply immediately. */
export async function authenticate(req, _res, next) {
  try {
    const header = req.get('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Missing token');
    let payload;
    try { payload = jwt.verify(token, config.jwtSecret); } catch { throw new HttpError(401, 'Invalid or expired token'); }
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, m.team_id, m.role, t.name AS team_name
         FROM users u
         LEFT JOIN memberships m ON m.user_id = u.id
         LEFT JOIN teams t ON t.id = m.team_id
        WHERE u.id = $1`, [payload.sub]);
    if (!rows.length) throw new HttpError(401, 'Unknown user');
    req.user = {
      id: rows[0].id, name: rows[0].name, email: rows[0].email,
      memberships: new Map(rows.filter((r) => r.team_id).map((r) => [r.team_id, r.role])),
      teams: rows.filter((r) => r.team_id).map((r) => ({ id: r.team_id, name: r.team_name, role: r.role })),
    };
    next();
  } catch (err) { next(err); }
}
