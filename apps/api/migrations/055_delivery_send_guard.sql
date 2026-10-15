CREATE TABLE IF NOT EXISTS orders.delivery_send_guards (
  account_id uuid NOT NULL REFERENCES accounts.accounts(id),
  order_no text NOT NULL,
  execution_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, order_no)
);

CREATE TABLE IF NOT EXISTS orders.delivery_send_steps (
  account_id uuid NOT NULL,
  order_no text NOT NULL,
  step_key text NOT NULL,
  execution_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending', 'succeeded', 'unknown')),
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, order_no, step_key),
  FOREIGN KEY (account_id, order_no) REFERENCES orders.delivery_send_guards(account_id, order_no)
);

ALTER TABLE coupons.coupon_reservations DROP CONSTRAINT IF EXISTS coupon_reservations_status_check;
ALTER TABLE coupons.coupon_reservations ADD CONSTRAINT coupon_reservations_status_check
  CHECK (status IN ('reserved', 'committed', 'released', 'expired', 'quarantined'));
