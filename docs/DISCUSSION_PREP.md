# Discussion prep (Newtonite review) — short answers

**Draw the architecture in 60 s.** Browser SPA → Express API (JWT, `authorize()`, workflow, services) → Postgres (items, events, idempotency keys, jobs outbox) ← Worker (polls jobs, writes notifications). Browser polls API.

**What happens when things fail?**
* *DB down:* API returns 500 / `/health` fails; worker logs and retries its loop; nothing is half-applied because every change is one transaction.
* *Worker crashes mid-job:* its transaction rolls back, row lock released, job is picked up again; handler is idempotent so no duplicate notification.
* *Network retry / double click:* same `Idempotency-Key` → stored response replayed, one item.
* *Two users collide:* claim → loser 409; stale edit → 409 + latest item, UI rolls back and offers reload.
* *Handler keeps failing:* backoff, then `failed` after `max_attempts` (visible in `jobs`).

**Which assumptions to check with a PM?** Can an assignee approve their own item? Should members move items they don't own? Can an item change team? SLA / due-date escalation? Who sees cross-team items (management view)?

**Which part matters most & why?** The write path in `items.js`: one transaction containing authorization, concurrency check, state change, history and outbox job. If that is wrong, ownership/history/trust in the system is wrong.

**At 10× scale?** See the last section of ENGINEERING_DECISIONS.md (replicas, partition `activity_events`, search engine, real queue, websockets/SSE).

**Next week?** TTL purge for idempotency keys/jobs; team/role admin UI; separation-of-duties for approval; SLA reminders via the outbox; SSE live updates; frontend tests (Playwright) incl. the rollback path; rate limiting + refresh tokens.

## Likely live-modification requests — where to change

| Request | Change |
|---|---|
| Add a new status (e.g. `on_hold`) | `STATUSES` + `TRANSITIONS` in `workflow.js`, CHECK constraint in `schema.sql` (drop/re-add), label in UI. Add a test. |
| Let Leads reassign (already) / let members reassign too | `ACTION_MIN_ROLE.reassign` in `permissions.js` |
| Block approving your own item | in `transitionProblem()`: if `to === 'resolved' && item.assignee_id === user.id && role !== 'admin'` → 403 |
| New priority level | `PRIORITIES` in `workflow.js` + CHECK in `schema.sql` |
| Notify on comments | `enqueueNotify` call in `addComment` (items.js) |
| New filter (e.g. overdue) | add a `where.push(...)` in `listItems` + maybe a partial index |
