-- Migration 011 shipped a hard-coded password in a public file.
-- A role that can log in with a known password is not an application
-- role. From here on, sync_app exists but cannot log in by default.
--
-- The operator grants LOGIN with a generated password in their own
-- environment, after the migrations have run. See CONTRIBUTING.md.
--
-- The migration runner connects as the database owner, so ALTER ROLE
-- is permitted without superuser rights.

ALTER ROLE sync_app NOLOGIN;
