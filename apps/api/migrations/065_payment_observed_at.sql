ALTER TABLE orders.payment_event_jobs
  ADD COLUMN IF NOT EXISTS observed_at timestamptz NOT NULL DEFAULT now();
