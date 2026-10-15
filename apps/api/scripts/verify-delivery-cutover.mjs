import pg from 'pg';
import { createHash } from 'node:crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  if (process.argv.includes('--state')) {
    const table = await pool.query("select to_regclass('orders.delivery_cutover_gate') as name");
    const gate = table.rows[0].name ? await pool.query('select active from orders.delivery_cutover_gate where id=true') : undefined;
    const state = !table.rows[0].name ? 'missing' : gate?.rows[0]?.active === true ? 'active' : 'inactive';
    process.stdout.write(`delivery cutover state: ${state}\n`);
  } else if (process.argv.includes('--preflight') || process.argv.includes('--preflight-list')) {
    const candidates = await pool.query(`with legacy as (
      select a.id as account_id, substr(l.execution_key,length('paid_auto_delivery:'||a.id::text||':')+1) as order_no
      from automation.execution_ledger l join accounts.accounts a
        on l.execution_key like 'paid_auto_delivery:'||a.id::text||':%'
      where length(l.execution_key)>length('paid_auto_delivery:'||a.id::text||':')
        and coalesce(l.result_json->>'status','') <> 'skipped'
      union
      select d.account_id,d.order_no from orders.delivery_records d where d.status <> 'pending'
      union
      select r.account_id,substr(r.execution_key,length(p.prefix)+1) from coupons.coupon_reservations r
      cross join lateral (select case
        when r.execution_key like 'paid_auto_delivery:'||r.account_id::text||':%' then 'paid_auto_delivery:'||r.account_id::text||':'
        when r.execution_key like 'manual-delivery:'||r.account_id::text||':%' then 'manual-delivery:'||r.account_id::text||':'
        else null end as prefix) p
      where r.purpose='delivery' and p.prefix is not null and length(r.execution_key)>length(p.prefix)
    ) select account_id::text,order_no from legacy order by account_id,order_no`);
    const unmapped = await pool.query(`select
      (select count(*)::int from coupons.coupon_reservations r where r.purpose='delivery' and not (
        (r.execution_key like 'paid_auto_delivery:'||r.account_id::text||':%' and length(r.execution_key)>length('paid_auto_delivery:'||r.account_id::text||':')) or
        (r.execution_key like 'manual-delivery:'||r.account_id::text||':%' and length(r.execution_key)>length('manual-delivery:'||r.account_id::text||':'))))
      + (select count(*)::int from automation.execution_ledger l where l.execution_key like 'paid_auto_delivery:%'
        and coalesce(l.result_json->>'status','') <> 'skipped'
        and not exists (select 1 from accounts.accounts a where l.execution_key like 'paid_auto_delivery:'||a.id::text||':%'
          and length(l.execution_key)>length('paid_auto_delivery:'||a.id::text||':'))) as count`);
    const lines = candidates.rows.map((row) => `${row.account_id}\t${row.order_no}`);
    const digest = createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex');
    if (process.argv.includes('--preflight-list')) process.stdout.write(`${lines.join('\n')}${lines.length ? '\n' : ''}`);
    else process.stdout.write(`delivery preflight: candidates=${lines.length} unmapped=${unmapped.rows[0].count} digest=${digest}\n`);
    process.exitCode = Number(unmapped.rows[0].count) > 0 ? 1 : 0;
  } else {
  const result = await pool.query(`select
    (select count(*)::int from automation.execution_ledger l
      join accounts.accounts a on l.execution_key like 'paid_auto_delivery:'||a.id::text||':%'
      where length(l.execution_key)>length('paid_auto_delivery:'||a.id::text||':')
        and coalesce(l.result_json->>'status','') <> 'skipped'
        and not exists (select 1 from orders.delivery_send_guards g where g.account_id=a.id
          and g.order_no=substr(l.execution_key,length('paid_auto_delivery:'||a.id::text||':')+1))) as unguarded_executions,
    (select count(*)::int from coupons.coupon_reservations r
      cross join lateral (select case
        when r.execution_key like 'paid_auto_delivery:'||r.account_id::text||':%' then 'paid_auto_delivery:'||r.account_id::text||':'
        when r.execution_key like 'manual-delivery:'||r.account_id::text||':%' then 'manual-delivery:'||r.account_id::text||':'
        else null end as prefix) p
      where r.purpose='delivery' and p.prefix is not null and length(r.execution_key)>length(p.prefix)
        and not exists (select 1 from orders.delivery_send_guards g where g.account_id=r.account_id
          and g.order_no=substr(r.execution_key,length(p.prefix)+1))) as unguarded_reservations,
    (select count(*)::int from coupons.coupon_reservations r where r.purpose='delivery' and not (
      (r.execution_key like 'paid_auto_delivery:'||r.account_id::text||':%' and length(r.execution_key)>length('paid_auto_delivery:'||r.account_id::text||':')) or
      (r.execution_key like 'manual-delivery:'||r.account_id::text||':%' and length(r.execution_key)>length('manual-delivery:'||r.account_id::text||':')))) as unmapped_delivery_reservations,
    (select count(*)::int from orders.delivery_records d
      where d.status <> 'pending'
        and not exists (select 1 from orders.delivery_send_guards g where g.account_id=d.account_id and g.order_no=d.order_no)) as unguarded_delivery_records,
    (select count(*)::int from coupons.coupon_reservations r
      where r.purpose='delivery' and r.status in ('committed','released','expired','quarantined')
        and (r.execution_key like 'paid_auto_delivery:'||r.account_id::text||':%' or r.execution_key like 'manual-delivery:'||r.account_id::text||':%')
        and not exists (select 1 from orders.delivery_send_guards g where g.account_id=r.account_id
          and g.order_no=substr(r.execution_key, strpos(r.execution_key, ':'||r.account_id::text||':')+length(r.account_id::text)+2))) as unguarded_committed_coupons,
    (select count(*)::int from orders.delivery_send_guards where status='unknown') as orders_for_manual_reconciliation,
    (select count(*)::int from orders.payment_event_jobs where event_ref like 'backfill:%') as paid_orders_backfilled`);
  const counts = result.rows[0];
  process.stdout.write(`delivery cutover: ${JSON.stringify(counts)}\n`);
  if (counts.unguarded_executions || counts.unguarded_reservations || counts.unmapped_delivery_reservations || counts.unguarded_delivery_records || counts.unguarded_committed_coupons) {
    throw new Error('DELIVERY_CUTOVER_UNGUARDED_LEGACY_WRITES');
  }
  if (process.argv.includes('--activate')) {
    await pool.query("update orders.delivery_cutover_gate set active=true,activated_at=now() where id=true");
    process.stdout.write('delivery cutover: activated\n');
  }
  }
} finally {
  await pool.end();
}
