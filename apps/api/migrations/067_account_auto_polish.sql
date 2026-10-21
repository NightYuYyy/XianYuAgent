-- 067: per-account automatic product polishing (擦亮).
alter table accounts.accounts add column if not exists auto_polish boolean not null default false;
