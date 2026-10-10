CREATE SEQUENCE IF NOT EXISTS global_sync_seq;

CREATE TABLE IF NOT EXISTS sites (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL DEFAULT 0,
  longitude DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS missions (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL,
  -- site_id is used by migration 006 to build the composite FK
  -- (site_id, tenant_id) -> sites (id, tenant_id). Without it,
  -- migrate on a fresh database fails at 006:35.
  site_id UUID,
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS check_ins (
  id UUID PRIMARY KEY,
  mission_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  check_in_time BIGINT NOT NULL,
  check_out_time BIGINT,
  check_in_lat DOUBLE PRECISION NOT NULL,
  check_in_lng DOUBLE PRECISION NOT NULL,
  check_in_method TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT
);

CREATE TABLE IF NOT EXISTS sync_idempotency_keys (
  id BIGSERIAL PRIMARY KEY,
  agent_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, idempotency_key)
);
