CREATE UNIQUE INDEX IF NOT EXISTS payment_event_jobs_order_idx
  ON orders.payment_event_jobs (account_id, order_no) WHERE order_no IS NOT NULL;
