-- 007_communication.sql
-- Task 28.4A — high-end messaging foundation.
-- Additive only; idempotent; no drops/rebuilds; no seed/fake rows.

-- ---------------------------------------------------------------------------
-- conversations
-- One per service request, never duplicated, tied to the request the
-- customer created and the technician who accepted through the offer flow.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  technician_id UUID NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_conversations_status'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT chk_conversations_status
      CHECK (status IN ('active', 'closed'));
  END IF;
END $$;

-- A service request can only have one conversation — enforced at DB level.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_service_request
  ON conversations (service_request_id);

CREATE INDEX IF NOT EXISTS idx_conversations_service_request_id
  ON conversations (service_request_id);
CREATE INDEX IF NOT EXISTS idx_conversations_customer_id
  ON conversations (customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_technician_id
  ON conversations (technician_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
  ON conversations (updated_at DESC);

-- ---------------------------------------------------------------------------
-- messages
-- Plain text only. No HTML storage. No attachments in this stage.
-- Sender derived server-side; never client-supplied.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  read_at TIMESTAMP WITH TIME ZONE
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_messages_length'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT chk_messages_length
      CHECK (char_length(message) BETWEEN 1 AND 2000);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id
  ON messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_read_lookup
  ON messages (conversation_id, read_at) WHERE read_at IS NULL;
