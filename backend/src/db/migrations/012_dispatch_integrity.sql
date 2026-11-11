-- 012_dispatch_integrity.sql
-- Task 36 (Stages 4–5) — dispatch integrity and lifecycle audit.
--
-- Adds the database structures the new server-authoritative dispatch engine
-- (backend/src/dispatch/dispatchService.ts) depends on:
--   A. service_requests: browser idempotency key + dispatch bookkeeping
--      columns (client_request_id, last_dispatch_at, dispatch_attempts).
--   B. technicians: availability_auto — marks availability changes that the
--      SYSTEM made because the workload cap was reached, so a manual
--      "unavailable" toggle is never overridden by the release sweeper.
--   C. service_request_events: the lifecycle audit trail (Phase 7
--      requirement 10) — one row per real status transition, with actor,
--      role and reason, written atomically with the change.
--   D. THE integrity rule the accept flow always implied: at most ONE
--      accepted offer per request. Any duplicate accepted rows (invalid
--      state the non-atomic accept could historically create) are corrected
--      FIRST, in-migration, by keeping the offer the existing conversation
--      points at (otherwise the most recently updated accepted offer) and
--      demoting the rest to 'rejected'. Demoted rows keep their history —
--      nothing is deleted. This is a deliberate correction of invalid
--      state, documented here because it changes existing rows.
--   E. Indexes matching the new hot paths: workload counting, pending-offer
--      sweeps, stuck/waiting request sweeps.
--   F. Runtime reachability for the new table (grants + RLS), mirroring
--      009/010/011 exactly: GRANT DML to umodzi_app, ENABLE RLS, ONE
--      p_app_all policy. Guarded so plain-PostgreSQL environments without
--      the role are a no-op.
--
-- Migration rules (same contract as 001–011):
--   * Additive and guarded; re-running is a no-op (IF NOT EXISTS / DO guards).
--   * No deletes, no truncation, no status or ownership rewrites. The only
--     row changes are the documented D. integrity correction.
--   * The idempotency index is PARTIAL (WHERE client_request_id IS NOT NULL):
--     legacy rows without a key are untouched and cannot collide.
--
-- Rollback (examined, data-safe): DROP INDEX/FK-constraint-safe order —
--   DROP TABLE service_request_events; DROP INDEX uq_dispatch_offers_one_accepted_per_request,
--   uq_service_requests_client_request_id, idx_offers_*, idx_requests_*;
--   ALTER TABLE service_requests/technicians DROP COLUMN (new columns only).
--   Demoted duplicate accepted offers cannot be restored from this migration
--   alone (their prior status was invalid state); that is why D. is recorded
--   in service_request_events terms in the application audit trail going
--   forward, and why the keeper choice favours the conversed assignment.

-- ===========================================================================
-- A. service_requests — idempotency + dispatch bookkeeping
-- ===========================================================================
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS client_request_id TEXT;
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS last_dispatch_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS dispatch_attempts INTEGER NOT NULL DEFAULT 0;

-- One outstanding submission per customer key. Partial: legacy keyless rows
-- never participate, so they cannot collide and are not rewritten.
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_requests_client_request_id
  ON service_requests (customer_user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- ===========================================================================
-- B. technicians — system-set availability flag
-- ===========================================================================
-- Default FALSE on existing rows is CORRECT: every availability value that
-- predates this column was set by the technician (or an admin), never by the
-- workload system, so none of them may be auto-restored.
ALTER TABLE technicians
  ADD COLUMN IF NOT EXISTS availability_auto BOOLEAN NOT NULL DEFAULT FALSE;

-- ===========================================================================
-- C. service_request_events — lifecycle audit trail
-- ===========================================================================
CREATE TABLE IF NOT EXISTS service_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- 'customer' | 'technician' | 'administrator' | 'system' (sweeper rows).
  actor_role TEXT
    CHECK (actor_role IN ('customer', 'technician', 'administrator', 'system')),
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_request_events_request
  ON service_request_events (request_id, created_at);

-- ===========================================================================
-- D. ONE accepted offer per request — integrity correction + hard rule
-- ===========================================================================
-- Correction pass: for every request with more than one accepted offer (a
-- state the old non-atomic accept could produce), keep the accepted offer the
-- existing conversation is tied to; when there is no conversation, keep the
-- most recently updated accepted offer (deterministic id tiebreak). Every
-- OTHER accepted row is demoted to 'rejected' — the demoted technician
-- profile keeps its offer history, no row is deleted.
DO $$
DECLARE
  dup record;
  keeper uuid;
BEGIN
  FOR dup IN
    SELECT request_id
      FROM dispatch_offers
     WHERE status = 'accepted'
     GROUP BY request_id
    HAVING COUNT(*) > 1
  LOOP
    SELECT o.id INTO keeper
      FROM dispatch_offers o
      LEFT JOIN conversations c ON c.service_request_id = o.request_id
     WHERE o.request_id = dup.request_id
       AND o.status = 'accepted'
     ORDER BY (c.id IS NOT NULL) DESC, o.updated_at DESC, o.id ASC
     LIMIT 1;

    UPDATE dispatch_offers
       SET status = 'rejected', updated_at = NOW()
     WHERE request_id = dup.request_id
       AND status = 'accepted'
       AND id <> keeper;
  END LOOP;
END $$;

-- The hard rule going forward: a second accept can no longer commit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_offers_one_accepted_per_request
  ON dispatch_offers (request_id) WHERE status = 'accepted';

-- ===========================================================================
-- E. Hot-path indexes (workload counts, sweeps)
-- ===========================================================================
-- Technician workload: accepted offers joined to requests still being served.
CREATE INDEX IF NOT EXISTS idx_offers_technician_status
  ON dispatch_offers (technician_id, status);
-- Request-side offer lookups (cascade exclusion, competing-offer closes).
CREATE INDEX IF NOT EXISTS idx_offers_request_status
  ON dispatch_offers (request_id, status);
-- Offer timeout sweeper: pending offers ordered by last update.
CREATE INDEX IF NOT EXISTS idx_offers_pending_updated
  ON dispatch_offers (updated_at) WHERE status = 'pending';
-- Stuck-'matching' recovery and general status sweeps.
CREATE INDEX IF NOT EXISTS idx_requests_status_updated
  ON service_requests (status, updated_at);
-- Waiting queue: no_match requests by their last dispatch attempt.
CREATE INDEX IF NOT EXISTS idx_requests_no_match_waiting
  ON service_requests (last_dispatch_at) WHERE status = 'no_match';

-- ===========================================================================
-- F. Runtime reachability + RLS for service_request_events
--    Mirrors 009/010/011: grant DML to umodzi_app, enable RLS, add p_app_all.
--    Guarded so plain-PostgreSQL CI (no umodzi_app role) is a no-op.
-- ===========================================================================
DO $$
DECLARE
  t text;
  role_available boolean;
BEGIN
  role_available := EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'umodzi_app'
  );

  FOREACH t IN ARRAY ARRAY['service_request_events'] LOOP
    IF role_available THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO umodzi_app', t
      );
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    IF role_available AND NOT EXISTS (
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
