import { HttpError } from './errors.js';
import { hasRole, rank } from './permissions.js';

export const STATUSES = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'];
export const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/**
 * Allowed transitions: from -> { to: minimum role }.
 * 'lead' is the approval gate: only a Lead/Admin of the item's team can pass awaiting_approval.
 * closed is terminal.
 */
export const TRANSITIONS = {
  open:              { in_progress: 'member' },
  in_progress:       { open: 'member', awaiting_approval: 'member' },
  awaiting_approval: { resolved: 'lead', in_progress: 'lead' },   // approve / reject
  resolved:          { closed: 'member', in_progress: 'member' }, // close / reopen
  closed:            {},
};

/** Returns null when allowed, or an HttpError describing why not. */
export function transitionProblem(item, to, user, role) {
  const rule = TRANSITIONS[item.status]?.[to];
  if (!rule) {
    const allowed = Object.keys(TRANSITIONS[item.status] ?? {});
    return new HttpError(422, `Invalid transition ${item.status} -> ${to}`, { allowed });
  }
  if (rank(role) < rank(rule)) {
    return new HttpError(403, `Moving ${item.status} -> ${to} requires the '${rule}' role in this team`);
  }
  // Regular members may only move items they own (or pick up an unowned open item).
  const isLead = hasRole(role, 'approve');
  const pickingUp = item.status === 'open' && to === 'in_progress' && item.assignee_id == null;
  if (!isLead && item.assignee_id !== user.id && !pickingUp) {
    return new HttpError(403, 'Only the assignee (or a lead) can change the status of this item');
  }
  return null;
}

export const allowedTransitions = (item, user, role) =>
  Object.keys(TRANSITIONS[item.status] ?? {}).filter((to) => !transitionProblem(item, to, user, role));
