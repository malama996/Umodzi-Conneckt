-- 002_authentication.sql
-- Task 23 — identity: users, refresh-token sessions, and ownership links.
--
-- Migration rules:
--   * Additive only. Existing technicians/service_requests/dispatch_offers
--     rows are preserved untouched.
--   * Existing rows predate authentication: their ownership columns are
--     added nullable and stay NULL. They are NOT claimed by anyone —
--     they remain readable only by administrators (and, for requests,
--     by any technician already holding an offer on them). New rows
--     always carry authenticated ownership.
--   * Every statement is idempotent (IF NOT EXISTS / guarded DO blocks)
--     so re-running against an already-upgraded database is a no-op.
--   * No passwords in plaintext anywhere: users.password_hash is an
--     argon2id hash; sessions store only a SHA-256 hash of the opaque
--     refresh token (the raw token lives solely in the HttpOnly cookie).

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'technician', 'administrator')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  account_status TEXT NOT NULL DEFAULT 'active'
    CHECK (account_status IN ('active', 'suspended', 'disabled')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Uniqueness on the NORMALIZED (lowercased, trimmed) email. Application
-- code also normalizes before every insert; this index is the hard backstop.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (lower(email));

-- ---------------------------------------------------------------------------
-- sessions — server-managed refresh-token sessions
--   token_hash : SHA-256 of the opaque refresh token (never the raw token)
--   revoked_at : set on rotation, logout, or reuse detection
--   revoked_reason : 'rotated' | 'logout' | 'reuse' — only 'rotated' sessions
--                    may be replayed inside a short rotation grace window
--                    (concurrent browser tabs refreshing at the same time).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE,
  revoked_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Ownership links (nullable on purpose — see header comment)
-- ---------------------------------------------------------------------------
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS customer_user_id UUID;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS user_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_service_requests_customer_user'
  ) THEN
    ALTER TABLE service_requests
      ADD CONSTRAINT fk_service_requests_customer_user
      FOREIGN KEY (customer_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_technicians_user'
  ) THEN
    ALTER TABLE technicians
      ADD CONSTRAINT fk_technicians_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- One account <-> at most one technician profile (NULLs allowed for the
-- seeded prototype technicians that have no account yet).
CREATE UNIQUE INDEX IF NOT EXISTS uq_technicians_user_id ON technicians(user_id);

CREATE INDEX IF NOT EXISTS idx_service_requests_customer_user_id
  ON service_requests(customer_user_id);
