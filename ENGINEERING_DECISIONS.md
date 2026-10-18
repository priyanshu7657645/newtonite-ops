# Engineering Decisions

Scope was deliberately kept to one tight vertical slice. Each decision lists the context, options considered, the choice, and what it costs.

## Assumptions I made (and would confirm with a product manager first)

1. A work item belongs to exactly **one team**; roles are **per team** (`viewer < member < lead < admin`).
2. Workflow is linear with two escape hatches: reject (`awaiting_approval → in_progress`) and reopen (`resolved → in_progress`). `closed` is terminal.
3. Approval is a **Lead/Admin of the item's team**. (Open question: should the assignee be barred from approving their own item?)
4. Members may only move items **they own**; anyone may pick up an unowned item. Only leads reassign other people.
5. "Urgent" = priority `urgent`. "Needs attention" = assigned to me and not finished / unassigned urgent / awaiting my approval.
6. Comments are part of the history stream (not a separate table) so there is one chronological source of truth.

## 1. Postgres as the single source of truth (data model & history)

**Context.** Needs transactions, row locks, constraints, partial indexes, full-text search, and a durable queue.
**Options.** Postgres only · Postgres + Redis (BullMQ) + Elasticsearch · a document DB.
**Choice.** Postgres for everything: items, append-only `activity_events`, `idempotency_keys`, a `jobs` outbox table, and full-text search (`tsvector` generated column + GIN).
Every state change writes **item + event (+ job) in one transaction**, so history can never disagree with the item. A DB trigger rejects `UPDATE/DELETE` on `activity_events`, so "append-only" is enforced by the database, not by convention.
**Trade-off.** One technology to run and reason about, strong consistency — but the DB is the scaling bottleneck and search quality is basic (see #5 and the 10× answer below).

## 2. Concurrency control: conditional update for claim, optimistic locking for edits

**Context.** Two people claim the same item; a user edits an old copy; many updates arrive close together.
**Options.** Pessimistic locks held across user think-time · last-write-wins · optimistic version check · serializable isolation everywhere.
**Choice.**
* **Claim** is one statement: `UPDATE … SET assignee_id=$me WHERE id=$1 AND assignee_id IS NULL AND status IN (…)`. Under READ COMMITTED the second concurrent statement waits for the row lock, re-evaluates the `WHERE`, matches 0 rows, and the API returns **409** with who won. No read-then-write race exists.
* **Edits and transitions** carry the `version` the client saw. The handler takes `SELECT … FOR UPDATE`, compares versions, applies the change and increments. Mismatch → **409 + the current item** so the UI can show "this item changed".
**Trade-off.** Users sometimes have to retry after a conflict (acceptable for this domain; better than silently overwriting). Comments deliberately do **not** bump `version`, so chatting never invalidates someone's edit.

## 3. Idempotency keys stored in the same transaction as the work

**Context.** Users double-click or retry when unsure whether a request succeeded.
**Options.** Disable buttons only · natural-key dedupe · client-generated `Idempotency-Key` stored server-side.
**Choice.** The client sends an `Idempotency-Key` (UUID per logical action, reused on retry). The server inserts `(user, key)` **inside the same transaction** as the change and stores the response there too. A parallel duplicate blocks on the unique key until the first commits, then replays the stored response (`Idempotent-Replay: true`). If the original attempt fails (409/403/…), the transaction — including the key — rolls back, so a retry is evaluated fresh. Reusing a key with a different payload → 422.
**Trade-off.** Keys accumulate (needs a TTL purge — listed in limitations). The UI also disables the button while a request is in flight; the key makes that protection hold even across network retries and multiple tabs.

## 4. Authorization on the server, one decision point; scale-aware reads

**Context.** Roles differ per team; hiding buttons is not security.
**Choice.**
* `authorize(user, teamId, action)` in `permissions.js` is the single role×action check used by every command and query. Roles are loaded from the DB **on every request** (not baked into the JWT), so a role change applies immediately.
* Lists are always filtered by `team_id = ANY(user's teams)` in SQL, so data from other teams cannot leak through filters or pagination. Non-members get **404** (don't reveal existence); under-privileged members get **403**.
* The API returns `can` flags per item for the UI; they are convenience only — the server re-checks on every call.
* **Lists** use **keyset pagination** on `(updated_at, id)` (stable, no deep-OFFSET cost) and never return totals (`COUNT(*)` on big tables is expensive); the three dashboard counters use **partial indexes** matching their predicates (`wi_assignee_open`, `wi_unassigned_urgent`, `wi_awaiting`). Verified with `EXPLAIN` on 20 000 items: dashboard queries use the partial indexes and respond in ~10 ms.
**Trade-off.** One extra query per request to load memberships (cheap, indexed; cacheable later). Multi-team list ordering can't use a single composite index perfectly — fine at tens of thousands of rows, revisit at scale.

## 5. Sync vs async: transactional outbox + at-least-once worker

**Context.** Notifications are secondary work; the primary action must not fail or slow down because of them, and must not lose them.
**Options.** Fire-and-forget in the request · publish to a broker after commit (dual-write problem) · transactional outbox.
**Choice.** The `notify` job row is inserted in the **same transaction** as the change, so either both exist or neither does (tested). A separate worker process claims jobs with `FOR UPDATE SKIP LOCKED` (many workers can run safely), retries with exponential backoff (2^n s, capped), stops at `max_attempts` and marks `failed`. Delivery is **at-least-once**, so the handler is **idempotent** (`UNIQUE(job_id, user_id)` + `ON CONFLICT DO NOTHING`). A crash mid-job rolls back its transaction and the job reappears.
**Trade-off.** Polling the table adds ≤1 s latency and DB load; ordering between jobs isn't guaranteed. Fine here; a real queue/`LISTEN/NOTIFY` would reduce latency at higher volume.

## What I intentionally did not build

E-mail/Slack delivery, attachments, SSO, websockets (15 s polling + 409 handling is enough), user/team admin UI, rate limiting, a SPA framework (vanilla JS keeps every line explainable and needs no build step), frontend test suite.

## What would change at 10× scale

* **Reads:** read replicas for list/dashboard queries; cache memberships; keep keyset pagination.
* **History:** partition `activity_events` by time (and archive cold partitions); it is the fastest-growing table.
* **Search:** move to OpenSearch/Meilisearch fed from the outbox if relevance/typo tolerance matters; Postgres FTS is the stopgap.
* **Async:** dedicated queue (SQS/RabbitMQ/BullMQ) or `LISTEN/NOTIFY` wake-ups; DLQ and alerting on `failed` jobs.
* **Realtime:** server-sent events/websockets instead of polling; per-item channels.
* **Hot rows:** if a few items become very hot, shorten transactions and consider per-item queues; add a TTL job for `idempotency_keys`.
