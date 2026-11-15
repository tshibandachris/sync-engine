-- 042: validate the pre-existing nonce-purge SECURITY DEFINER owner boundary.
-- Migration 039 intentionally remains immutable; this migration closes the
-- pre-existing-role gap without silently repairing a potentially compromised role.
BEGIN;

DO $verify$
DECLARE
  v_owner_oid oid;
BEGIN
  SELECT r.oid
    INTO v_owner_oid
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = 'device_proof_maintenance_function_owner';

  IF v_owner_oid IS NULL THEN
    RAISE EXCEPTION
      'SECURITY_MIGRATION_FAILED: device proof maintenance function owner is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles r
     WHERE r.oid = v_owner_oid
       AND NOT r.rolcanlogin
       AND NOT r.rolsuper
       AND NOT r.rolcreatedb
       AND NOT r.rolcreaterole
       AND NOT r.rolreplication
       AND NOT r.rolbypassrls
  ) THEN
    RAISE EXCEPTION
      'SECURITY_MIGRATION_FAILED: device proof maintenance function owner has unsafe attributes';
  END IF;

  -- No memberships in either direction: the owner cannot inherit another
  -- role's privileges, and no other role can inherit or SET ROLE to this owner.
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members m
     WHERE m.member = v_owner_oid
        OR m.roleid = v_owner_oid
  ) THEN
    RAISE EXCEPTION
      'SECURITY_MIGRATION_FAILED: device proof maintenance function owner has role memberships';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
     WHERE p.oid = 'public.purge_expired_device_proof_nonces(uuid,integer)'::regprocedure
       AND p.proowner = v_owner_oid
  ) THEN
    RAISE EXCEPTION
      'SECURITY_MIGRATION_FAILED: nonce purge SECURITY DEFINER function has an unexpected owner';
  END IF;
END
$verify$;

COMMIT;
