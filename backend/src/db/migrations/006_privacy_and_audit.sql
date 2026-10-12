-- 006_privacy_and_audit.sql
-- Task 28.3 — privacy/security foundations: the audit log, plus the
-- read-state support the data-subject notification inbox (28.3C/G-02) needs.
--
-- Migration rules (same contract as 001-005):
--   * Additive only. No DROP, no truncation, no rewrite of existing rows.
--   * Idempotent: IF NOT EXISTS / guarded DO blocks, so re-running against an
--     already-upgraded database is a no-op.
--   * No seed rows are inserted. Audit history is created ONLY from real
--     events observed by the running system — never fabricated, back-dated
--     or pre-populated. A new installation starts with an empty audit log,
--     and that is the honest state.

-- ---------------------------------------------------------------------------
-- audit_events — privacy/security event log (Task 28.3F)
--
-- DESIGN DECISIONS (each one deliberate and load-bearing):
--
-- 1. NO FOREIGN KEY to users, ON PURPOSE.
--    An audit record is a security record ABOUT a person, not data owned by
--    them. If audit_events referenced users(id), it would be impossible to
--    honour a permanent account-deletion request (28.3D) without either
--    deleting the security history — which would destroy the accountability
--    record — or blocking the deletion. Storing plain UUIDs with no FK lets
--    the user's own rows disappear while the security history correctly
--    survives, minimised (see point 3).
--
-- 2. NO IP ADDRESS COLUMN, ON PURPOSE.
--    The system does not store client IP addresses anywhere today. Adding
--    broad IP collection to an audit table would introduce a new, pervasive
--    personal-data category as a side effect of a logging feature. It is
--    deliberately NOT introduced here. If a deployment later establishes a
--    concrete abuse-investigation requirement, that is a separate change
--    with its own privacy notice, retention rule and legal confirmation.
--
-- 3. actor_user_id / target_user_id reference users WITHOUT constraining them.
--    After a deletion the ids remain as opaque UUIDs. That is intentional and
--    is the minimum needed for an administrator to answer "which account did
--    this, and what happened to it". Nothing personal is denormalised into
--    the row: no email, no name, no request text, no document content.
--
-- 4. metadata is a bounded JSONB bag for technical detail only
--    (counts, reasons, capability names, provider names). Callers must never
--    place credentials, tokens, password material, document bytes or free-text
--    personal data in it. The application layer enforces a key allow-list.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  -- Actor: who performed the action. NULL when the actor is unauthenticated
  -- (e.g. a failed login for an email that matches no account).
  actor_user_id UUID,
  actor_role TEXT,
  -- Target: whose data or which entity the action affected. For self-service
  -- actions (export, deletion) actor and target are the same account.
  target_user_id UUID,
  target_entity_type TEXT,
  target_entity_id UUID,
  outcome TEXT NOT NULL DEFAULT 'success',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_audit_events_outcome'
  ) THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT chk_audit_events_outcome
      CHECK (outcome IN ('success', 'failure', 'denied'));
  END IF;
END $$;

-- Administrator review queries: newest first, then per-type and per-actor
-- investigations. Indexes only — no uniqueness, because an audit log must be
-- append-only and may legitimately contain repeated event types.
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at_desc
  ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_type_created
  ON audit_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor
  ON audit_events (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_target
  ON audit_events (target_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- notification read state (Task 28.3C / G-02)
--
-- `notifications.read` and `notifications.read_at` already exist (migration
-- 005) and are maintained by NotificationService.markAsRead(). No schema
-- change is required for the subject-facing inbox: the data-subject read
-- surface reuses the D1 notification architecture rather than introducing a
-- second, competing notification store.
--
-- This block exists only to guarantee the partial index the inbox's unread
-- counter relies on is present and named deterministically. It is additive
-- and safe on an already-upgraded database.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread_created
  ON notifications (user_id, created_at DESC) WHERE read = false;
