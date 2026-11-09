-- 011_verification_review_and_password_reset.sql
-- Production-readiness audit (§5 technician verification trust model +
-- §3 password recovery). Two additive, independent changes:
--
--   A. Per-document verification review. The prior model (003) stored a
--      SINGLE whole-profile decision on `technicians` and treated documents
--      as one replaceable evidence set with no individual outcome. This
--      migration adds per-document review metadata, an append-only review
--      history table, richer document categories, and a 'partially_verified'
--      lifecycle state — so the overall status can be DERIVED from the
--      individual document outcomes rather than asserted on upload.
--
--   B. Password recovery. A `password_reset_tokens` table holding only a
--      HASHED, single-use, time-limited token (the raw token is never
--      stored). Consumed by the /auth/reset-password flow.
--
-- Migration rules (same contract as 001-010):
--   * Additive only. No DROP TABLE, no TRUNCATE, no rewrite of existing
--     rows (the single backfill below only SETs a default status on
--     pre-existing document rows; it never deletes or re-types them).
--   * Expanding a CHECK constraint is done by DROP CONSTRAINT IF EXISTS +
--     re-ADD inside this transaction, so there is never a committed window
--     without the constraint. The new value sets are SUPERSETS of the old,
--     so every existing row remains valid.
--   * Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / guarded DO
--     blocks (pg_constraint, pg_policies, pg_roles), so re-running against
--     an already-upgraded database is a no-op.
--   * Runtime reachability: the least-privilege runtime role `umodzi_app`
--     (NOSUPERUSER NOBYPASSRLS) is granted DML only via an explicit script
--     over a fixed table list, and 009 revoked default Data API privileges.
--     Therefore every NEW table here is explicitly GRANTed to umodzi_app and
--     given RLS + the same `p_app_all` policy used in 010 — otherwise the
--     backend could not read/write it at runtime. Both steps are guarded by
--     a pg_roles existence check so plain-PostgreSQL CI is unaffected.
--
-- Rollback (examined, data-safe): DROP the two new tables, DROP the added
--   columns/constraints, re-ADD the original 3-value document_type CHECK and
--   4-value verification_status CHECK, DROP the granted policies. No
--   existing row is modified by the forward migration beyond the documented
--   status backfill, so rollback loses only new-model data.

-- ===========================================================================
-- A. PER-DOCUMENT VERIFICATION REVIEW
-- ===========================================================================

-- A1. Richer document categories. Superset of ('national_id','certificate',
--     'other') so all existing rows stay valid.
DO $$
BEGIN
  ALTER TABLE technician_verification_documents
    DROP CONSTRAINT IF EXISTS chk_verification_documents_type;
  ALTER TABLE technician_verification_documents
    ADD CONSTRAINT chk_verification_documents_type
    CHECK (document_type IN (
      'national_id',
      'certificate',
      'trade_qualification',
      'professional_licence',
      'business_registration',
      'training_certificate',
      'other'
    ));
END $$;

-- A2. Per-document review columns (nullable except status, which defaults to
--     'pending' so freshly uploaded documents await review).
ALTER TABLE technician_verification_documents
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE technician_verification_documents
  ADD COLUMN IF NOT EXISTS reviewed_by UUID;
ALTER TABLE technician_verification_documents
  ADD COLUMN IF NOT EXISTS review_reason TEXT;
ALTER TABLE technician_verification_documents
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP WITH TIME ZONE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_verification_documents_status'
  ) THEN
    ALTER TABLE technician_verification_documents
      ADD CONSTRAINT chk_verification_documents_status
      CHECK (status IN ('pending', 'approved', 'rejected'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_verification_documents_reviewed_by'
  ) THEN
    ALTER TABLE technician_verification_documents
      ADD CONSTRAINT fk_verification_documents_reviewed_by
      FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- A3. Overall lifecycle gains 'partially_verified'. Superset of the original
--     ('unverified','pending','verified','rejected'); existing rows valid.
DO $$
BEGIN
  ALTER TABLE technicians
    DROP CONSTRAINT IF EXISTS chk_technicians_verification_status;
  ALTER TABLE technicians
    ADD CONSTRAINT chk_technicians_verification_status
    CHECK (verification_status IN (
      'unverified', 'pending', 'partially_verified', 'verified', 'rejected'
    ));
END $$;

-- A4. Append-only review history. One row per reviewer decision on a single
--     document, so previous decisions and resubmission history survive even
--     though the current decision also lives on the document row.
CREATE TABLE IF NOT EXISTS verification_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES technician_verification_documents(id) ON DELETE CASCADE,
  technician_id UUID NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_reviews_document_id
  ON verification_reviews(document_id);
CREATE INDEX IF NOT EXISTS idx_verification_reviews_technician_id
  ON verification_reviews(technician_id);

-- A5. One-time backfill of document status for pre-existing evidence. A
--     technician already 'verified' under the old whole-profile model had
--     their evidence accepted, so those documents become 'approved'. Every
--     other pre-existing document becomes 'pending' (awaiting review under
--     the new per-document model). technicians.verification_status is NOT
--     touched here — the overall status stays exactly as it was until an
--     administrator acts under the new model.
UPDATE technician_verification_documents d
   SET status = 'approved'
  FROM technicians t
 WHERE d.technician_id = t.id
   AND t.verification_status = 'verified'
   AND d.status = 'pending'
   AND d.reviewed_at IS NULL;

-- ===========================================================================
-- B. PASSWORD RECOVERY
-- ===========================================================================

-- B1. Only a HASH of the recovery token is stored; the raw token exists only
--     in the emailed link. Single-use via consumed_at; time-limited via
--     expires_at. Cascades away with the user.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  consumed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_tokens_hash
  ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
  ON password_reset_tokens(user_id);

-- ===========================================================================
-- C. RUNTIME REACHABILITY + RLS FOR THE NEW TABLES
--    Mirrors 009/010: grant DML to umodzi_app, enable RLS, add p_app_all.
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

  FOREACH t IN ARRAY ARRAY['verification_reviews', 'password_reset_tokens'] LOOP
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
