CREATE TABLE IF NOT EXISTS accounts.health_signals (
  account_id uuid NOT NULL REFERENCES accounts.accounts(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('verification_required','degraded')),
  source text NOT NULL,
  code text,
  episode uuid,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (account_id,kind,source)
);

INSERT INTO accounts.health_signals(account_id,kind,source,code,episode,last_seen_at)
SELECT id,'verification_required',coalesce(risk_source,'legacy'),risk_code,risk_episode,coalesce(risk_last_seen_at,updated_at)
FROM accounts.accounts WHERE risk_episode IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO accounts.health_signals(account_id,kind,source,last_seen_at)
SELECT id,'degraded',coalesce(degraded_source,'legacy'),degraded_at
FROM accounts.accounts WHERE degraded_at IS NOT NULL
ON CONFLICT DO NOTHING;
