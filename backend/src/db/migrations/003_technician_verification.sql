-- 003_technician_verification.sql
-- Task 26 — technician profile enrichment (bio, profile photo) and the
-- verification lifecycle (unverified → pending → verified | rejected →
-- pending …) with evidence documents.
--
-- Migration rules (same contract as 001/002):
--   * Additive only. No DROP, no rewrites of existing rows.
--   * Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / guarded DO
--     blocks, so re-running against an already-upgraded database is a no-op.
--   * The legacy `verified` BOOLEAN stays as the canonical "is verified"
--     flag consumed by the dispatch trust score, public badges, and the
--     Task 25 admin surface. `verification_status` is the new lifecycle;
--     the two are kept consistent in APPLICATION code at every write
--     (verified ⟺ verification_status = 'verified'). Existing rows are
--     backfilled once: verified = true → 'verified'.
--   * `photo_key` / `storage_key` are OPAQUE storage references resolved
--     by the backend storage layer — never filesystem paths and never
--     served directly, so no local-machine layout leaks into records.

-- ---------------------------------------------------------------------------
-- technicians: bio + photo + verification lifecycle columns
-- ---------------------------------------------------------------------------
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS photo_key TEXT;

ALTER TABLE technicians ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS verification_rejection_reason TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS verification_submitted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS verification_reviewed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS verification_reviewed_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_technicians_verification_status'
  ) THEN
    ALTER TABLE technicians
      ADD CONSTRAINT chk_technicians_verification_status
      CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_technicians_verification_reviewed_by'
  ) THEN
    ALTER TABLE technicians
      ADD CONSTRAINT fk_technicians_verification_reviewed_by
      FOREIGN KEY (verification_reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- One-time backfill: rows already trusted under the legacy boolean enter
-- the lifecycle as 'verified'. Everything else stays 'unverified'
-- (registered-but-never-reviewed technicians included).
UPDATE technicians
   SET verification_status = 'verified'
 WHERE verified = true
   AND verification_status = 'unverified';

-- ---------------------------------------------------------------------------
-- technician_verification_documents — evidence submitted for review
--   document_type : national_id | certificate | other
--   storage_key   : opaque key resolved by the backend storage layer
--   file_name     : original client filename (display only, sanitized)
-- Review metadata lives on the technicians row (the current decision);
-- documents are the CURRENT evidence set and are replaced on resubmission.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS technician_verification_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id UUID NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  storage_key TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_verification_documents_type'
  ) THEN
    ALTER TABLE technician_verification_documents
      ADD CONSTRAINT chk_verification_documents_type
      CHECK (document_type IN ('national_id', 'certificate', 'other'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_verification_documents_storage_key
  ON technician_verification_documents(storage_key);
CREATE INDEX IF NOT EXISTS idx_verification_documents_technician_id
  ON technician_verification_documents(technician_id);
