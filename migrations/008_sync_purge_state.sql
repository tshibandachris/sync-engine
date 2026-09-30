CREATE TABLE IF NOT EXISTS sync_purge_state (
  tenant_id        UUID   PRIMARY KEY,
  purged_up_to_seq BIGINT NOT NULL CHECK (purged_up_to_seq >= 0),
  updated_at       BIGINT NOT NULL
);