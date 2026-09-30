-- Application role for RLS-enforced connections.
-- Not the owner of any table, not a superuser, so RLS applies.
DROP ROLE IF EXISTS sync_app;

CREATE ROLE sync_app LOGIN PASSWORD 'sync_app_pw';

GRANT USAGE ON SCHEMA public TO sync_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sync_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sync_app;

-- Apply the same grants to future tables/sequences created by the owner.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sync_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sync_app;
