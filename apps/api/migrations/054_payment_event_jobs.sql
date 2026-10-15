CREATE TABLE IF NOT EXISTS orders.payment_event_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES auth.admins(id),
  account_id uuid NOT NULL REFERENCES accounts.accounts(id),
  event_ref text NOT NULL,
  order_no text,
  buyer_ref text NOT NULL,
  item_ref text,
  conversation_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('resolve_pending', 'pending', 'running', 'completed', 'manual_review')),
  attempt_count int NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  owner_token text,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, event_ref)
);
CREATE INDEX IF NOT EXISTS payment_event_jobs_due_idx
  ON orders.payment_event_jobs (next_attempt_at, received_at)
  WHERE status IN ('resolve_pending', 'pending', 'running');
