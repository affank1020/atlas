-- Atlas Sessions: first-class, project-independent coordination state.
CREATE TABLE atlas_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  objective text NOT NULL CHECK (length(objective) BETWEEN 1 AND 8000),
  summary text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  revision bigint NOT NULL DEFAULT 1,
  coordinator_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE session_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES atlas_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('coordinator', 'worker')),
  label text NOT NULL,
  credential_hash text NOT NULL UNIQUE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE atlas_sessions ADD CONSTRAINT atlas_sessions_coordinator_fk
  FOREIGN KEY (coordinator_id) REFERENCES session_participants(id);
CREATE UNIQUE INDEX session_one_coordinator ON session_participants(session_id) WHERE role = 'coordinator';
CREATE INDEX session_participants_session_idx ON session_participants(session_id, joined_at);
CREATE TABLE session_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES atlas_sessions(id) ON DELETE CASCADE,
  title text NOT NULL,
  brief text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','active','blocked','submitted','accepted')),
  assignee_id uuid REFERENCES session_participants(id),
  result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((assignee_id IS NOT NULL) OR status = 'queued')
);
CREATE INDEX session_assignments_queue ON session_assignments(session_id, status, priority DESC, created_at);
CREATE TABLE session_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES atlas_sessions(id) ON DELETE CASCADE,
  participant_id uuid REFERENCES session_participants(id),
  kind text NOT NULL CHECK (kind IN ('created','joined','assigned','updated','submitted','reviewed','message','decision','closed')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_events_recent ON session_events(session_id, id DESC);
-- Enforce same-session ownership even when rows are modified outside the service.
ALTER TABLE session_participants ADD CONSTRAINT session_participants_scoped_id UNIQUE (session_id,id);
ALTER TABLE atlas_sessions ADD CONSTRAINT atlas_sessions_scoped_coordinator
  FOREIGN KEY (id,coordinator_id) REFERENCES session_participants(session_id,id);
ALTER TABLE session_assignments ADD CONSTRAINT session_assignments_scoped_assignee
  FOREIGN KEY (session_id,assignee_id) REFERENCES session_participants(session_id,id);
ALTER TABLE session_events ADD CONSTRAINT session_events_scoped_participant
  FOREIGN KEY (session_id,participant_id) REFERENCES session_participants(session_id,id);
