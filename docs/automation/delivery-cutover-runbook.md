# 发货切换与历史补发操作手册

## 发布门禁

1. 在生产只读环境取得脱敏的支付 IM 卡片、`NOT_SHIP` 列表和对应订单详情样本。核对卡片订单号、订单买家 ID、商品 ID、支付/售后/发货状态与当前解析结果；系统通知发送者 ID 不应被当作买家 ID。
2. 首次切换前备份 PostgreSQL，并保存迁移前旧发货记录、自动发货 ledger 和卡券预占的只读统计。用新版 API 镜像执行 `node scripts/verify-delivery-cutover.mjs --preflight-list` 导出候选 `account_id + order_no` 清单到受控位置；`--preflight` 输出候选数、未映射数及该清单的 SHA-256 摘要，不输出订单号。未映射数必须为 0。明确 `skipped` 的 ledger 无外部发送，不进入候选清单。
3. 候选数大于 0 时，逐单核对清单后，在生产部署目录 `.delivery-cutover-approval` 写入一行 `<本次 release 完整 Git SHA> <preflight digest>`。发布脚本在停旧 API/worker 前后各运行一次预检，校验签收值及候选数/摘要；清单或代码变化必须重新核对和签收。停机后二次核对失败且迁移尚未开始时，脚本尝试恢复旧 API/worker。该文件不进入 Git，也不把逐单清单写入 CI 日志。签收仅表示已接管未知订单，不代表这些订单可重发。
4. 迁移后运行 `node scripts/verify-delivery-cutover.mjs`。所有 `unguarded_*` 和 `unmapped_delivery_reservations` 必须为 0；保存 `orders_for_manual_reconciliation` 数量和逐单清单。该数字不是可自动补发数量。
5. 只有生产样本、历史清单、人工复核负责人和回滚预案都记录完毕，才激活 cutover gate 并启动新版 API/worker。发布脚本要求旧 API/worker 停机前都在线，并在新版健康验收和发布结束时确认两者仍运行；迁移后后端验收失败会停止新版进程，按数据库现状人工恢复，不自动启动旧版。发现前述证据缺口时，保持旧进程运行，不进入停机切换。

历史候选签收与旧 ledger 全量护栏核验仅适用于 `orders.delivery_cutover_gate` 尚不存在的首次切换。gate 已激活的后续发布仍停止写入、执行迁移并复核 gate 状态，但 060 不再回填历史订单，也不重复签收；新版在外发前失败的 ledger 可合法地没有发送护栏，不能套用旧 ledger 全量核验。若 gate 已创建却未激活，或 gate 已激活但当前运行容器缺少新版切换脚本，须先人工核查，不走自动切换。

## 未知发货清单

使用只读数据库连接导出以下查询结果，存放在受控工单中，不贴到公开 CI 日志。逐单记录账号、订单号、旧执行键、订单状态、卡券预占状态、自动任务状态和审核人。

```sql
SELECT g.account_id, g.order_no, g.execution_key, g.updated_at,
       o.payment_status, o.order_status, o.delivery_status, o.after_sales_status,
       (SELECT string_agg(DISTINCT r.status, ',') FROM coupons.coupon_reservations r
        WHERE r.account_id=g.account_id AND r.execution_key=g.execution_key) AS reservation_status,
       (SELECT string_agg(DISTINCT d.status, ',') FROM orders.delivery_records d
        WHERE d.account_id=g.account_id AND d.order_no=g.order_no) AS delivery_record_status,
       (SELECT string_agg(DISTINCT j.status, ',') FROM orders.payment_event_jobs j
        WHERE j.account_id=g.account_id AND j.order_no=g.order_no) AS payment_job_status
FROM orders.delivery_send_guards g
LEFT JOIN orders.orders o ON o.account_id=g.account_id AND o.order_no=g.order_no
WHERE g.status='unknown'
ORDER BY g.account_id, g.order_no;
```

对每单核对平台订单详情和买家会话中的文本、图片、卡券内容与发货操作；留存平台时间戳及脱敏证据摘要。平台显示待发货不等于消息未发送，旧流程可能先发送卡券，再在后续步骤失败。

## 逐单裁决

- **已发送、部分发送或证据冲突**：保持 `unknown` guard，不重发卡券；将任务留在人工复核，按平台实际发货状态完成订单处理。部分发送需先核对卡券库存和买家已收到内容。记录审核人与证据摘要。
- **明确未发送**：须同时证明无买家可见的文本/图片/卡券、无平台发货操作、订单仍为已付/未发且无售后。双人复核后记录 `delivery.cutover.confirmed_not_sent` 审计（操作者、工单号、证据 SHA-256），保持 `unknown` guard 和任务人工复核状态，再从平台人工履约并刷新权威订单状态。旧失败 ledger 可能已用尽重试次数，已释放或过期的卡券预占也不保证可重领；不得仅删除 guard、重排 payment job 或重复点击自动发货来尝试补发。
- **确认已发送但本地订单仍待发**：保持 guard，记录 `delivery.cutover.confirmed_sent` 审计，停止该单自动任务；通过平台权威订单刷新同步状态。平台仍待发而消息已经送达时，先由人工处理平台发货，再刷新本地订单。

普通 `pending`/`resolve_pending` 任务的延迟恢复由 worker 自动处理：原定延迟尚未到期时继续等待，到期且平台订单、账号状态可用时领取。历史 `unknown` 单独走上述人工履约，不纳入自动补发成功率。任何新出现的 `unknown` 继续人工核查，不通过重复点击或重启绕过。

无订单号的支付 IM 事件只唤醒该账号的 `NOT_SHIP` 扫描，不能凭买家、商品或会话把它绑定到某个旧订单。完整扫描后，源任务以 `completed`、`order_no IS NULL`、`last_error='ORDER_ID_UNAVAILABLE_SCAN_COMPLETE'` 结束；超过 100 页时扫描前 100 页后移交周期对账，以 `last_error='ORDER_ID_UNAVAILABLE_RECONCILE_HANDOFF'` 结束，深页继续从游标扫描，不再每分钟重扫源任务。这两种 `completed` 都只表示事件信号已消费，**不表示订单已发货或深页已扫描完成**。扫描发现的待发订单会以 `reconcile:<orderNo>` 创建独立的精确订单号任务，之后仍须经过平台 `ALL` 查询、权威详情和发货护栏。扫描请求失败时源任务保持 `resolve_pending` 并重试；周期对账每轮扫前 100 页并续扫至多 100 个深页，直到扫完后再回卷。排查漏发时按 `order_no` 核查精确任务与平台订单，不将无号任务的 `completed` 计入发货成功数。深页对账的恢复时间取决于总页数和平台响应耗时，超过 100 页的晚付款不承诺 30 秒内发现。

```sql
SELECT status, last_error, count(*) AS jobs
FROM orders.payment_event_jobs
WHERE order_no IS NULL
GROUP BY status, last_error
ORDER BY status, last_error;
```

## 回滚

新版本运行后的数据库迁移与旧二进制的写入语义不兼容。只回滚前端或 API 镜像而继续旧版自动发货会绕过新的发送护栏；回滚时应先停 API/worker，保持发货 gate 关闭或暂停相关写入，按备份和逐单审计制定恢复步骤，不直接启动旧版写入进程。
