ALTER TABLE accounts.accounts DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE accounts.accounts ADD CONSTRAINT accounts_status_check
  CHECK (status IN ('pending', 'connected', 'degraded', 'disconnected', 'expired', 'verification_required', 'disabled'));

ALTER TABLE accounts.accounts
  ADD COLUMN IF NOT EXISTS risk_code text,
  ADD COLUMN IF NOT EXISTS risk_source text,
  ADD COLUMN IF NOT EXISTS risk_first_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS risk_last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS risk_episode uuid;

CREATE TABLE IF NOT EXISTS accounts.risk_alert_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts.accounts(id) ON DELETE RESTRICT,
  episode uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('verification_required', 'verification_cleared')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (account_id, episode, event_type)
);
CREATE INDEX IF NOT EXISTS risk_alert_outbox_pending_idx
  ON accounts.risk_alert_outbox (created_at) WHERE status = 'pending';
