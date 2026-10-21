-- 069: 商品自动续售任务队列。
-- 商品成交付款（或操作员手动触发）后，按同一套标题/描述/图片/价格重新发布一条新链接，
-- 并把自动发货配置迁到新链接。续售开关存放在 products.products.attributes_json.autoRelist。
create table if not exists products.auto_relist_jobs (
  id uuid primary key,
  admin_id uuid not null,
  account_id uuid not null,
  product_id uuid not null references products.products(id) on delete cascade,
  order_no text,
  source text not null default 'order',
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  due_at timestamptz not null default now(),
  lease_until timestamptz,
  owner_token text,
  new_product_id uuid,
  new_external_product_ref text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists auto_relist_jobs_due_idx on products.auto_relist_jobs (status, due_at);
create index if not exists auto_relist_jobs_product_idx on products.auto_relist_jobs (product_id, created_at desc);
-- 同一商品同一订单只排一次队（已结束的任务不占用约束）。
create unique index if not exists auto_relist_jobs_open_order_idx on products.auto_relist_jobs (product_id, order_no) where order_no is not null and status in ('pending', 'running');
