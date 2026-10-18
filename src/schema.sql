-- Idempotent schema (safe to run on every start). Postgres 12+ (generated column).

CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  email         text UNIQUE NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id   serial PRIMARY KEY,
  name text UNIQUE NOT NULL
);

-- A user can be in many teams, with a different role in each.
CREATE TABLE IF NOT EXISTS memberships (
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role    text NOT NULL CHECK (role IN ('viewer','member','lead','admin')),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX IF NOT EXISTS memberships_team ON memberships (team_id);

CREATE TABLE IF NOT EXISTS work_items (
  id          bigserial PRIMARY KEY,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  type        text NOT NULL CHECK (type IN ('incident','customer_issue','payment','compliance','task')),
  priority    text NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  team_id     int NOT NULL REFERENCES teams(id),
  assignee_id int REFERENCES users(id),
  created_by  int NOT NULL REFERENCES users(id),
  due_date    date,
  version     int NOT NULL DEFAULT 1,           -- optimistic-locking counter
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  search      tsvector GENERATED ALWAYS AS
              (to_tsvector('simple', title || ' ' || description)) STORED
);
-- Indexes chosen for the list/dashboard queries (see ENGINEERING_DECISIONS.md #4)
CREATE INDEX IF NOT EXISTS wi_team_updated ON work_items (team_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS wi_updated      ON work_items (updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS wi_assignee_open ON work_items (assignee_id, updated_at DESC, id DESC)
  WHERE status NOT IN ('resolved','closed');
CREATE INDEX IF NOT EXISTS wi_unassigned_urgent ON work_items (team_id, updated_at DESC)
  WHERE assignee_id IS NULL AND priority = 'urgent' AND status IN ('open','in_progress');
CREATE INDEX IF NOT EXISTS wi_awaiting ON work_items (team_id, updated_at DESC)
  WHERE status = 'awaiting_approval';
CREATE INDEX IF NOT EXISTS wi_search ON work_items USING gin (search);

-- Append-only history (also holds comments, kind = 'comment').
CREATE TABLE IF NOT EXISTS activity_events (
  id         bigserial PRIMARY KEY,
  item_id    bigint NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  actor_id   int REFERENCES users(id),
  kind       text NOT NULL,   -- created | status_changed | assignee_changed | priority_changed | edited | comment
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ae_item ON activity_events (item_id, id DESC);

CREATE OR REPLACE FUNCTION forbid_activity_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS activity_append_only ON activity_events;
CREATE TRIGGER activity_append_only BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_activity_mutation();

-- Stored responses for retried/double-submitted requests.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id      int  NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status_code  int,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Transactional outbox: rows are written in the SAME transaction as the change.
CREATE TABLE IF NOT EXISTS jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_at       timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (run_at, id) WHERE status = 'pending';

-- Output of the 'notify' job. UNIQUE(job_id, user_id) makes the handler idempotent.
CREATE TABLE IF NOT EXISTS notifications (
  id         bigserial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id),
  item_id    bigint REFERENCES work_items(id) ON DELETE CASCADE,
  message    text NOT NULL,
  job_id     bigint NOT NULL,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, user_id)
);
CREATE INDEX IF NOT EXISTS notif_user ON notifications (user_id, id DESC);
