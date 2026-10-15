CREATE TABLE IF NOT EXISTS accounts.risk_notifications (
  alert_id uuid NOT NULL REFERENCES accounts.risk_alert_outbox(id),
  admin_id uuid NOT NULL REFERENCES auth.admins(id),
  account_id uuid NOT NULL REFERENCES accounts.accounts(id),
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  PRIMARY KEY (alert_id,admin_id)
);
CREATE INDEX IF NOT EXISTS risk_notifications_unread_idx
  ON accounts.risk_notifications(admin_id,created_at DESC) WHERE read_at IS NULL;
