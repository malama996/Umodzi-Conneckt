-- 004_reviews.sql
-- Task 27 — customer ratings & reviews tied to completed services.
--
-- A review is the customer's verdict on ONE completed service request:
-- exactly one review per service request (unique index), written by the
-- request's owning customer about the technician who accepted the job.
-- Identity columns are always derived server-side — never client input.
--
-- Migration rules (same contract as 001–003):
--   * Additive only. No DROP, no rewrites of existing rows.
--   * Idempotent: IF NOT EXISTS / guarded DO blocks.
--   * No seed/fake reviews are inserted — production reputation data
--     starts empty and grows only from real completed services.

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  technician_id UUID NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL,
  comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_reviews_rating'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT chk_reviews_rating
      CHECK (rating BETWEEN 1 AND 5);
  END IF;
END $$;

-- One review per completed service — the hard backstop behind the API's
-- 409-on-duplicate check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_service_request ON reviews(service_request_id);
CREATE INDEX IF NOT EXISTS idx_reviews_technician_id ON reviews(technician_id);
CREATE INDEX IF NOT EXISTS idx_reviews_customer_id ON reviews(customer_id);
