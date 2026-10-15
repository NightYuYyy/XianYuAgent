ALTER TABLE accounts.accounts
  ADD COLUMN IF NOT EXISTS degraded_source text,
  ADD COLUMN IF NOT EXISTS degraded_at timestamptz;

UPDATE accounts.accounts
SET degraded_at=coalesce(degraded_at,updated_at)
WHERE status='degraded' AND degraded_at IS NULL;
