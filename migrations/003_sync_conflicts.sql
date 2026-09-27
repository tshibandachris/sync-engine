BEGIN;

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  client_version BIGINT NOT NULL,
  server_version BIGINT NOT NULL,
  client_payload JSONB NOT NULL,
  server_payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS sync_conflicts_agent_status_idx
  ON sync_conflicts (agent_id, status);

CREATE INDEX IF NOT EXISTS sync_conflicts_entity_idx
  ON sync_conflicts (entity_type, entity_id);

COMMIT;