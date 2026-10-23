-- 卡密使用备注：自动发货记订单号，人工取卡记 manual
ALTER TABLE coupons.coupon_items ADD COLUMN IF NOT EXISTS usage_note text;
