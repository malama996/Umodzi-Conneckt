-- ============================================================================
-- Umodzi Connect — local scratch database setup
--
-- Run this in pgAdmin's Query Tool, connected to the "postgres" database, using
-- a connection that can authenticate (your saved pgAdmin connection).
--
-- You do NOT need to know the current postgres password for step 1: ALTER ROLE
-- replaces it. Replace only the text inside the quotes.
-- ============================================================================

-- 1. Set a fresh password for the local postgres role.
--    Use something long and local-only. Never reuse a Supabase or Render secret.
ALTER ROLE postgres WITH PASSWORD 'PUT_A_NEW_LOCAL_PASSWORD_HERE';

-- 2. Create the disposable database the tests run against.
--    Safe to re-run; any previous scratch database is replaced.
DROP DATABASE IF EXISTS umodzi_test;
CREATE DATABASE umodzi_test;

-- 3. Confirm PostGIS is available to that database.
--    (Migration 001 creates the extension itself, as superuser. This only checks
--     that the files are present, which they are: 3.6.2 on PostgreSQL 18.)
\connect umodzi_test
CREATE EXTENSION IF NOT EXISTS postgis;
SELECT postgis_version() AS postgis_version;

-- Expected: 3.6 USE_GEOS=1 USE_PROJ=1 USE_STATS=1  (minor detail may differ)
--
-- After this, either give the new password to the assistant, or run the suite
-- yourself:
--     PGPASSWORD='your-new-password' bash docs/run-db-tests.sh
--
-- Nothing here touches Supabase. The test runner refuses any non-local host.
