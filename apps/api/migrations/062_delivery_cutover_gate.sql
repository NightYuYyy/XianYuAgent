CREATE TABLE IF NOT EXISTS orders.delivery_cutover_gate (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  active boolean NOT NULL DEFAULT false,
  activated_at timestamptz
);
INSERT INTO orders.delivery_cutover_gate(id,active) VALUES (true,false) ON CONFLICT(id) DO NOTHING;
