ALTER TABLE orders.payment_event_jobs ADD COLUMN IF NOT EXISTS due_at timestamptz;
