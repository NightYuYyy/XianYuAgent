DO $backfill$
DECLARE cutover_active boolean := false;
BEGIN
IF to_regclass('orders.delivery_cutover_gate') IS NOT NULL THEN
  EXECUTE 'SELECT active FROM orders.delivery_cutover_gate WHERE id=true' INTO cutover_active;
END IF;
IF NOT coalesce(cutover_active,false) THEN
INSERT INTO orders.delivery_send_guards(account_id,order_no,execution_key,status)
SELECT a.id, substr(l.execution_key,length('paid_auto_delivery:'||a.id::text||':')+1), l.execution_key, 'unknown'
FROM automation.execution_ledger l
JOIN accounts.accounts a ON l.execution_key LIKE 'paid_auto_delivery:'||a.id::text||':%'
WHERE length(l.execution_key)>length('paid_auto_delivery:'||a.id::text||':')
  AND coalesce(l.result_json->>'status','') <> 'skipped'
ON CONFLICT(account_id,order_no) DO NOTHING;

INSERT INTO orders.delivery_send_guards(account_id,order_no,execution_key,status)
SELECT DISTINCT ON (d.account_id,d.order_no) d.account_id,d.order_no,'legacy-delivery:'||d.id::text,'unknown'
FROM orders.delivery_records d
WHERE d.status <> 'pending'
ORDER BY d.account_id,d.order_no,d.updated_at DESC
ON CONFLICT(account_id,order_no) DO NOTHING;

INSERT INTO orders.delivery_send_guards(account_id,order_no,execution_key,status)
SELECT DISTINCT ON (r.account_id, r.execution_key) r.account_id,
  substr(r.execution_key, length(prefix.execution_prefix) + 1), r.execution_key, 'unknown'
FROM coupons.coupon_reservations r
CROSS JOIN LATERAL (SELECT CASE
  WHEN r.execution_key LIKE 'paid_auto_delivery:'||r.account_id::text||':%' THEN 'paid_auto_delivery:'||r.account_id::text||':'
  WHEN r.execution_key LIKE 'manual-delivery:'||r.account_id::text||':%' THEN 'manual-delivery:'||r.account_id::text||':'
  ELSE NULL END AS execution_prefix) prefix
WHERE r.purpose='delivery' AND prefix.execution_prefix IS NOT NULL
  AND length(r.execution_key)>length(prefix.execution_prefix)
ORDER BY r.account_id, r.execution_key, r.updated_at DESC
ON CONFLICT(account_id,order_no) DO NOTHING;

INSERT INTO orders.payment_event_jobs(admin_id,account_id,event_ref,order_no,buyer_ref,item_ref,conversation_ref,status,received_at,next_attempt_at)
SELECT scope.admin_id,o.account_id,'backfill:'||o.order_no,o.order_no,o.buyer_id,o.item_id,coalesce(o.conversation_id,''),'pending',now(),now()
FROM orders.orders o
JOIN LATERAL (
  SELECT s.admin_id FROM auth.account_scopes s
  WHERE s.account_id=o.account_id AND s.scope='manage' AND s.status='active'
    AND (s.expires_at IS NULL OR s.expires_at>now())
  ORDER BY s.admin_id LIMIT 1
) scope ON true
WHERE o.source='xianyu' AND o.payment_status='paid' AND o.order_status='open'
  AND o.delivery_status='pending' AND o.after_sales_status='none'
  AND o.buyer_id<>'unknown-buyer' AND o.item_id<>'unknown-item'
ON CONFLICT DO NOTHING;
END IF;
END $backfill$;
