CREATE TABLE IF NOT EXISTS orders.delivery_confirmation_snapshots (
  account_id uuid NOT NULL REFERENCES accounts.accounts(id),
  order_no text NOT NULL,
  execution_key text NOT NULL,
  no_logistics_form boolean NOT NULL,
  trade_text_ciphertext bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, order_no)
);
