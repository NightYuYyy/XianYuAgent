# 项目经验与回归约束

修改用户界面、错误处理或账号状态时，必须先检查本文对应约束，并为新增错误码补齐中文映射和回归测试。

## 2026-10-20：风险通知侵入页面布局、账号表格泄露原始错误码

### 引入提交与根因

两处问题均由 `70f6ca1fbc63807c222597b9e3a7d01d6f4893c7` 引入，提交时间为 **2026-10-15 17:42:36 +08:00**，标题为 `fix(自动化): 修复支付触发发货与账号风控状态`。

- `apps/web/src/app/App.tsx` 在 `.desktop-body` 与 `main` 之间加入三个 `account-risk-banner` 分支，将账号刷新错误、未读风控通知、待验证账号直接放入文档流。同一风险同时命中两个分支，既重复显示，又压缩业务页面空间。
- `apps/web/src/features/accounts/components/AccountTable.tsx` 直接输出 `account.riskCode`，并把 `riskSource` 放进 `title`，导致 `ACCOUNT_VALIDATION_REQUIRED` 等后端诊断信息出现在产品界面。
- 已有中文账号状态徽标并不能保护旁边新增的原始字段。已有测试覆盖账号操作和列表结构，缺少“原始错误码不得进入可见文本/属性”和“错误反馈不得改变页面布局”的行为断言。

可复查命令：

```powershell
git log --all --format='%h %ad %s' --date=iso -S 'account-risk-banner' -- apps/web
git log --all --format='%h %ad %s' --date=iso -S 'account.riskCode' -- apps/web/src/features/accounts/components/AccountTable.tsx
git show 70f6ca1 -- apps/web/src/app/App.tsx apps/web/src/features/accounts/components/AccountTable.tsx
```

### 后续必须遵守的规则

1. **错误和风险通知统一使用右下角全局 Toast。** 新代码通过 `useToast().showToast()` 进入共享 `ToastProvider`，复用 `shared/ui/Toast.tsx`。禁止在 AppShell、业务文档流、表格、弹窗正文中另加操作失败横幅、错误段落或自制 Toast。全局反馈只保留一个显示出口，支持关闭、动作按钮和自动消失。
2. **产品状态必须为中文。** 账号风险通过 `features/accounts/feedback.ts` 的 `accountRiskLabel()` 转换，`ACCOUNT_VALIDATION_REQUIRED` → “需要安全验证”，`RGV587`、`CAPTCHA`、`X5SEC` 等 → “需滑块验证”；未识别风险码也使用“需要安全验证”。服务端错误通过 `accountErrorMessage()` 转换；未知错误返回该操作的中文兜底。
3. **禁止把诊断信息当作产品文案。** 不直接渲染 `error.message`、`error.code`、`riskCode`、`riskSource`、供应商返回值或堆栈，也不能塞进 `title`、`aria-label` 等用户可访问属性。即使已有状态徽标，旁边的补充信息仍须遵守此规则。后端原码继续用于 API 诊断和日志，不改动后端业务判断。
4. **轮询必须去重，通知与业务状态必须分开。** 同一未读通知 ID、同一账号风险指纹在组件存续期间只提示一次；关闭或超时消失不调用已读接口；“已知晓”只确认通知，不清除账号验证风险。失败确认必须保留中文重试入口，并禁用重复提交。
5. **页面状态与错误详情分工明确。** 页面可以保留加载中、空列表、无权限、暂不可用等状态和重试入口；失败原因交给 Toast。删除前的业务后果说明、二维码验证操作指引属于任务内容，可以保留，但不能附带原始异常。
6. **新增错误码必须同时提交映射和行为测试。** 除正常码外，必须覆盖未知码、缺省值、后端诊断来源，不能用“已有全量测试通过”替代本次故障的回归断言。

### 本次实现的模块边界

- `shared/ui/Toast.tsx` / `ToastProvider.tsx`：共享展示、操作按钮、队列、同 ID 更新和自动消失；不解释账号业务。
- `app/AccountRiskFeedback.tsx`：账号风险与通知去重、查看账号、确认及失败重试；AppShell 只组合组件。
- `features/accounts/feedback.ts`：账号风险中文标签、账号错误中文映射与安全兜底。
- 账号页面及登录表单：触发 Toast，保留业务状态和必要的恢复操作；表格只显示中文状态徽标。

### 验证证据与边界

修复前新增的表格回归测试有 **3 项失败**，能复现标准风险码、供应商风险码和未知风险码直接进入表格。修复前的真实 Chrome 页面等待 `.app-toast` 超时，复现缺失全局反馈的问题。

修复后执行：

| 命令 | 结果 |
| --- | --- |
| `npm --workspace apps/web run test` | 97 个测试文件、432 项测试通过，无跳过 |
| `npm --workspace apps/web run build` | 类型检查及生产构建通过；保留现有的大 chunk 体积提示 |
| `npm --workspace apps/web run test:e2e:chrome:account-feedback` | 真实 Chrome + Vite + 真实 `createApp` HTTP API + 隔离 `MemoryStore`，通过 |
| `git diff --check` | 通过 |

浏览器验收覆盖：1440×900 与 390×844 截图、顶部横幅不存在、表格与页面 DOM 不含原始风险码和诊断来源、Toast 固定在右下角、两轮 3 秒轮询后关闭的提示不重现、跨页面“查看账号”、确认通知失败及重试、Cookie/密码/二维码错误中文映射、列表与全局账号刷新失败及恢复、单一 Toast 队列、删除失败后保留弹窗并重试成功。确认已读后查询真实测试存储，验证通知已读且账号仍需验证。

可重复运行的浏览器脚本位于 `apps/web/scripts/e2e-account-feedback.mjs`，机器可读结果在 [result.json](evidence/account-feedback/result.json)。截图输出为 `docs/evidence/account-feedback/accounts-desktop.png` 和 `accounts-mobile.png`，按仓库既有规则忽略生成图片。

本次变更不涉及数据库结构、后端状态机或远程部署，因此无迁移要求；未连接生产数据库，也未执行真实闲鱼操作。供应商登录边界使用确定性测试替身，HTTP 路由、账号服务、通知已读和页面装配均为真实实现。内置浏览器打开请求处于排队状态、可连接列表为空，实际 UI 验收使用系统 Chrome 自动化完成。

回滚应一并回滚本次前端组件、中文映射及对应测试，不修改后端风险记录。不得通过重新展示原始错误码来排障。
