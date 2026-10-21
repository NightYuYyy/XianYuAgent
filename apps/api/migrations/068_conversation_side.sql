-- 068: which side of a conversation the account is on.
-- 'seller'  = the item belongs to the account, the counterpart is a buyer (auto-reply allowed)
-- 'buyer'   = the account is asking about someone else's item (auto-reply forbidden)
-- 'unknown' = not resolved yet or the lookup failed (auto-reply forbidden)
alter table messages.conversations add column if not exists side text not null default 'unknown';
