-- 066: per-account outbound proxy.
-- Every Xianyu request made on behalf of the account (MTOP, IM, QR login,
-- verification browser) is routed through this HTTP(S) proxy when set.
alter table accounts.accounts add column if not exists proxy_url text;
