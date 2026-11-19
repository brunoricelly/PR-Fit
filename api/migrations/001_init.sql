-- PR Fit API store. Every row keeps the full original object in `data` (lossless round-trip with
-- db.json); promoted columns exist only for foreign keys and lookups. `seq` preserves array order.

CREATE TABLE users (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE creds (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creds_user_id_idx ON creds(user_id);

CREATE TABLE coach_athlete_links (
  id text PRIMARY KEY,
  coach_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  athlete_id text REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coach_athlete_links_coach_id_idx ON coach_athlete_links(coach_id);
CREATE INDEX coach_athlete_links_athlete_id_idx ON coach_athlete_links(athlete_id);

CREATE TABLE coach_invites (
  id text PRIMARY KEY,
  link_id text NOT NULL REFERENCES coach_athlete_links(id) ON DELETE CASCADE,
  coach_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  data jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coach_invites_coach_id_idx ON coach_invites(coach_id);
CREATE INDEX coach_invites_link_id_idx ON coach_invites(link_id);
CREATE UNIQUE INDEX coach_invites_token_hash_idx ON coach_invites(token_hash);

-- Per-user profile document (state-<uid>.json today), optimistic concurrency by rev.
CREATE TABLE user_state (
  uid text PRIMARY KEY,
  doc jsonb NOT NULL,
  rev integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every other top-level db key (arrays of rows): coachPrescriptions, mealPlans, challenges, ...
CREATE TABLE collections (
  collection text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX collections_seq_idx ON collections(collection, seq);
CREATE INDEX collections_coach_id_idx ON collections(collection, (data->>'coachId')) WHERE data ? 'coachId';
CREATE INDEX collections_athlete_id_idx ON collections(collection, (data->>'athleteId')) WHERE data ? 'athleteId';
CREATE INDEX collections_user_id_idx ON collections(collection, (data->>'userId')) WHERE data ? 'userId';

-- Scalar / non-array top-level keys (schemaVersion, ...) plus '$arrays' = names of array keys present.
CREATE TABLE meta (
  k text PRIMARY KEY,
  v jsonb NOT NULL
);
