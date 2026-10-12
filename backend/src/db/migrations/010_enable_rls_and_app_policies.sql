-- 010_enable_rls_and_app_policies.sql
-- Task 35.2 (DB-1/DB-2 continuation) — enable Row Level Security on every
-- application table and add the ONE legitimate policy: full access for the
-- dedicated runtime role `umodzi_app` (created by
-- scripts/task352-create-runtime-role.ts; this migration must run AFTER it).
--
-- WHY a full-access policy for the app role is the CORRECT mapped access
-- (not a lazy bypass): Umodzi Connect's row-level rules (customer owns
-- their request; technician sees conversations they belong to; admin
-- override; push subscriptions owner-scoped; ...) are enforced in the
-- application layer by requireAuth/requireRole preHandlers and ownership
-- re-checks, and are verified by the 413-check regression suite. Changing
-- that model would require app changes far beyond this audit's scope.
-- What RLS adds here is the missing DB-layer ISOLATION guarantee: with
-- policies scoped `TO umodzi_app` only, every other role — anon,
-- authenticated, service_role, or any future role/grant regression — is
-- DENIED by default even if table privileges ever come back. That is
-- defense-in-depth, not a re-declaration of app rules.
--
-- Migration rules (same contract as 001-009):
--   * No data changes whatsoever. Enabling RLS and adding policies touch
--     no rows.
--   * Idempotent: ENABLE ROW LEVEL SECURITY is a no-op when already
--     enabled; policies are guarded via pg_policies existence checks.
--   * schema_migrations is deliberately NOT under RLS: it is the
--     migration bookkeeping table, admin-only at the privilege layer
--     (the runtime role has no grants on it at all).
--
-- Rollback (examined, data-safe): ALTER TABLE ... DISABLE ROW LEVEL
-- SECURITY + DROP POLICY p_app_all — privilege/policy-only operations.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'sessions', 'technicians', 'service_requests', 'dispatch_offers',
    'conversations', 'messages', 'notifications', 'push_subscriptions',
    'user_phones', 'technician_verification_documents', 'reviews', 'audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'p_app_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY p_app_all ON %I FOR ALL TO umodzi_app USING (true) WITH CHECK (true)',
        t
      );
    END IF;
  END LOOP;
END $$;
