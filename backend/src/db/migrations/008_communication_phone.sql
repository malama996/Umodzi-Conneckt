-- 008_communication_phone -- Task 28.4B (Step 11) phone contact foundation
-- Additive only; idempotent. Stores an authoritative phone number for
-- a technician's account, with basic E.164-style normalization and a
-- unique index so duplicate accounts don't have duplicate numbers.
-- This is the smallest schema change needed to make /requests/:id/contact
-- return a valid number instead of 404, and must be followed by privacy
-- notice updates (new processing category) and retention/deletion rules.

CREATE TABLE IF NOT EXISTS user_phones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_normalized TEXT NOT NULL,
  phone_raw TEXT NOT NULL,
  country_code TEXT DEFAULT '+260',
  purpose TEXT NOT NULL DEFAULT 'service_contact',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_phones_user_phone ON user_phones(user_id, phone_normalized);
CREATE INDEX IF NOT EXISTS idx_user_phones_user_id ON user_phones(user_id);
CREATE INDEX IF NOT EXISTS idx_user_phones_phone_normalized ON user_phones(phone_normalized);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_phones_purpose') THEN
    ALTER TABLE user_phones ADD CONSTRAINT chk_user_phones_purpose
      CHECK (purpose IN ('service_contact', 'emergency_contact', 'verification'));
  END IF;
END $$;
