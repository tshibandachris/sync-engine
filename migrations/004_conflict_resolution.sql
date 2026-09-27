BEGIN;

ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS resolution TEXT;
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS resolved_by UUID;
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS resolved_at BIGINT;

CREATE INDEX IF NOT EXISTS sync_conflicts_status_idx ON sync_conflicts (status);

COMMIT;