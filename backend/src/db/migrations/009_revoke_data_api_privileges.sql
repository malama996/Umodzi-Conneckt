-- 009_revoke_data_api_privileges.sql
-- Task 35.2 (DB-1) — close the Data API privilege exposure found in the
-- Task 35.1 audit: the Supabase roles `anon`, `authenticated` and
-- `service_role` held full CRUD+TRUNCATE+TRIGGER grants on every public
-- table while RLS was disabled everywhere. Umodzi Connect never uses the
-- Supabase Data API (its frontend holds no publishable key; the backend
-- connects directly over the Postgres wire protocol), so these grants are
-- pure exposure and are removed.
--
-- Migration rules (same contract as 001-008):
--   * Additive-only in spirit: this changes PRIVILEGES, never data. No
--     DROP, no truncation, no row rewrites. Audit history untouched.
--   * Idempotent: REVOKE and ALTER DEFAULT PRIVILEGES are no-ops when
--     there is nothing to revoke, so re-running is safe.
--   * Only default ACLs owned by `postgres` are altered (the supabase_admin
--     default ACLs only apply to objects created by supabase_admin — none
--     of this project's tables are).
--
-- Rollback (privilege-only, examined, data-safe): see the companion note
-- in STATE.md §29 — re-grant ALL to the three roles restores the exact
-- prior grant state; no data operation is involved.

-- 1. Stop future tables from silently regaining Data API access.
--    (New tables created by migrations would otherwise pick these up
--    through the default ACLs below.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public FOR ROLE postgres
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public FOR ROLE postgres
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public FOR ROLE postgres
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;

-- 2. Revoke every existing grant on every public table/sequence from the
--    Data API roles. The `postgres` role owns all these objects, so it
--    can revoke; no owner transfer needed.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;
