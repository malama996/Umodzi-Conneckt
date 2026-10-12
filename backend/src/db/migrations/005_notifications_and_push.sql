-- 005_notifications_and_push.sql
-- Task 28 — Real database-backed notification center & Web Push subscriptions.

-- 1. Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'in_app',
  reference_type TEXT,
  reference_id UUID,
  read BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'sent',
  provider_message_id TEXT,
  failure_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMP WITH TIME ZONE,
  read_at TIMESTAMP WITH TIME ZONE
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_notifications_channel'
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT chk_notifications_channel
      CHECK (channel IN ('in_app', 'sms', 'push', 'email'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_notifications_status'
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT chk_notifications_status
      CHECK (status IN ('pending', 'sent', 'delivered', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id_unread ON notifications(user_id) WHERE read = false;
CREATE INDEX IF NOT EXISTS idx_notifications_created_at_desc ON notifications(created_at DESC);

-- 2. Create push_subscriptions table
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_push_subscriptions_user_endpoint ON push_subscriptions(user_id, endpoint);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
