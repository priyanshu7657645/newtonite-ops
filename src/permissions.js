import { HttpError } from './errors.js';

export const ROLE_RANK = { viewer: 1, member: 2, lead: 3, admin: 4 };

/**
 * Role x action matrix. Value = minimum role (inside the item's team) required.
 * This is the ONLY place that decides who can do what; every route/service goes through authorize().
 */
export const ACTION_MIN_ROLE = {
  view: 'viewer',
  comment: 'member',
  create: 'member',
  claim: 'member',
  edit: 'member',        // title, description, type, priority, due date
  transition: 'member',  // normal workflow moves
  reassign: 'lead',      // assign an item to somebody else
  approve: 'lead',       // awaiting_approval -> resolved / back to in_progress
};

export const rank = (role) => ROLE_RANK[role] ?? 0;
export const hasRole = (role, action) => rank(role) >= rank(ACTION_MIN_ROLE[action]);

/**
 * Resource-level check. `user.memberships` is a Map(teamId -> role) loaded from the DB on every request.
 * Non-members get 404 (we do not reveal that the item exists); members with too low a role get 403.
 */
export function authorize(user, teamId, action) {
  const role = user.memberships.get(teamId);
  if (!role) throw new HttpError(404, 'Not found');
  if (!hasRole(role, action)) throw new HttpError(403, `Your role '${role}' in this team cannot ${action.replace('_', ' ')}`);
  return role;
}

export const leadTeamIds = (user) =>
  [...user.memberships].filter(([, role]) => rank(role) >= rank('lead')).map(([id]) => id);
