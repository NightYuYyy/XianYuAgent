ALTER TABLE accounts.accounts
  ADD COLUMN IF NOT EXISTS transport_status text NOT NULL DEFAULT 'disconnected'
    CHECK (transport_status IN ('connecting', 'connected', 'disconnected', 'failed')),
  ADD COLUMN IF NOT EXISTS transport_seen_at timestamptz;
