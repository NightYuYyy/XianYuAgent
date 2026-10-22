# realmouse-solver · 闲鱼滑块真人鼠标求解器

跑在**有桌面的 Windows** 上的小服务。服务器上的 XianyuSellerAgent 遇到闲鱼滑块（punish 链接）时，把链接和账号 Cookie 交给它；它用本机 Chrome 打开链接，按录好的真人轨迹用系统级鼠标事件（`SendInput`）滑过去，把新的 `x5sec` 返回给服务器。

**为什么要有它**：闲鱼 Baxia/NC 风控会拒绝任何 CDP 注入的鼠标事件（返回 `code=300, sig=from bx`），轨迹再像人也没用；只有物理鼠标能过。服务器没有桌面，所以这一步必须由一台 Windows 机器代劳。

> 许可证：本目录为 AGPL-3.0（引擎来自 zhinianboke/xianyu-auto-reply），与仓库其余部分不同，详见 `NOTICE.md`。

## 整体链路

```text
闲鱼返回 punish 链接
  → apps/api  XianyuVerificationBrowser（XIANYU_SLIDER_REMOTE_* 已配置）
  → POST http://172.17.0.1:18095/api/v1/captcha/slider-solve      ← docker0 网关
  → 服务器 sshd 反向隧道 172.17.0.1:18095 → Windows 127.0.0.1:18095
  → service.py 用本机 Chrome + 真人鼠标过滑块，返回 {"cookies": {"x5sec": ...}}
  → apps/api 把 x5sec 写回账号 Cookie，重试原请求
```

远程求解器不可达时，服务器按 `XIANYU_SLIDER_REMOTE_FALLBACK` 决定回退本地算法（`local`，几乎必败但保留人工流程）还是直接失败（`none`）。

## 一、Windows 侧安装

前置：Windows 10/11 桌面会话（不能是无界面的 RDP 断开状态或服务账户）、Chrome、[uv](https://docs.astral.sh/uv/)、能免密 `ssh server94` 的 OpenSSH（Git for Windows 自带的即可）。

```powershell
cd <repo>\tools\realmouse-solver
uv venv -p 3.11 .venv
uv pip install -p .venv fastapi uvicorn playwright loguru pydantic pyautogui
Copy-Item .env.example .env        # 然后把 SOLVER_SECRET 改成长随机串
```

目录里会多出三个被 gitignore 的运行时目录：`.venv/`、`browser_data/`（Chrome 档案，含 Cookie，**绝不能提交**）、`logs/`。

### 启动 / 停止

```powershell
# 后台拉起 service.py + 隧道循环，隐藏窗口，关掉终端也不会死
powershell -ExecutionPolicy Bypass -File run-detached.ps1

# 停止两者
Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'realmouse-solver[\\/](service\.py|tunnel\.ps1)' } | % { Stop-Process -Id $_.ProcessId -Force }

# 前台调试（看日志）
powershell -ExecutionPolicy Bypass -File start.ps1
```

本机自检：`curl http://127.0.0.1:18095/health` 应返回 `"real_mouse_available": true`。

## 二、SSH 反向隧道

`tunnel.ps1` 是一个死循环：掉线 3 秒后重连，日志在 `logs/tunnel.log`。它执行的核心命令是

```powershell
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
    -N -R 172.17.0.1:18095:127.0.0.1:18095 server94
```

绑在 `172.17.0.1`（docker0 网关）而不是 127.0.0.1，是为了让 api 容器能访问。服务器 sshd 需要两个 drop-in（server94 已配好）：

```text
/etc/ssh/sshd_config.d/10-gatewayports.conf   GatewayPorts clientspecified
/etc/ssh/sshd_config.d/11-clientalive.conf    ClientAliveInterval 15
                                              ClientAliveCountMax 3
```

第二个很重要：国内到海外的 SSH 经常被 reset，若服务端不探活，僵尸 `sshd-session` 会一直占着 18095，新隧道绑不上（日志出现 `remote port forwarding failed for listen port 18095`）。

## 三、服务器侧配置

在 `apps/api` 的 `.env`（生产为 `/opt/xianyu-agent/src/.env`）加：

```dotenv
XIANYU_SLIDER_REMOTE_URL=http://172.17.0.1:18095/api/v1/captcha/slider-solve
XIANYU_SLIDER_REMOTE_SECRET=<与 Windows .env 的 SOLVER_SECRET 一致>
XIANYU_SLIDER_REMOTE_TIMEOUT_MS=120000      # 整次请求预算
XIANYU_SLIDER_REMOTE_BROWSER_TIMEOUT=60     # 传给求解器的浏览器超时（秒）
XIANYU_SLIDER_REMOTE_FALLBACK=local         # local | none
```

改完重建 api 容器（`docker compose -f compose.prod.yml -f compose.web.yml up -d --build api`）。api 启动日志会打一条 `remote_slider_configured`。

### 在后台里查看状态

后台 **设置 → 滑块求解器** 会调用 `GET /api/v1/system/slider-solver`：api 进程自己去探测求解器的 `/health`，显示是否配置、是否可达、真人鼠标引擎是否可用、累计通过/失败次数和最近一次结果时间。隧道掉了在这里一眼能看出来；页面是只读的，地址和密钥仍只在 `.env` 里。

命令行验证（服务器上）：

```bash
curl -s http://172.17.0.1:18095/health
# {"status":"ok","real_mouse_available":true,"platform":"win32","requests":0,...}
```

## 四、接口协议

与 xianyu-auto-reply 的远程打码接口同协议，所以任何实现该协议的求解器都能替换本服务。

```http
POST /api/v1/captcha/slider-solve
{"secret_key": "...", "account_id": "...", "url": "<punish url>",
 "browser_timeout": 60, "cookies": "k=v; k2=v2", "device_id": ""}

200 {"success": true,  "message": "ok", "data": {"cookies": {"x5sec": "..."}}}
200 {"success": false, "message": "验证链接已过期", "data": {"url_expired": true}}   # 调用方刷新链接后重试
200 {"success": false, "message": "滑块验证未通过"}
401 {"success": false, "message": "秘钥错误"}

GET /health
{"status":"ok","real_mouse_available":true,"platform":"win32",
 "requests":12,"success":11,"failed":1,"url_expired":0,"last_result_at":"2026-10-22 14:30:00"}
```

- `cookies` 必须带：不带的话拿到的 `x5sec` 绑不到账号。
- 物理鼠标只有一个，服务内部串行处理；并发请求会排队。

## 五、排障

| 现象 | 看哪里 | 处理 |
| --- | --- | --- |
| 后台显示「不可达 · 连接被拒绝」 | Windows 上 `Get-Process` 里有没有 service.py / tunnel.ps1 | `run-detached.ps1` 重新拉起 |
| 后台显示「不可达 · 连接超时」或 `tunnel.log` 反复 reconnecting | 服务器 `ss -ltnp \| grep 18095` | 有僵尸 sshd 占端口就 `kill <pid>`，隧道循环 3 秒内自动重连 |
| `remote port forwarding failed for listen port 18095` | 同上 | 同上；也检查 `GatewayPorts clientspecified` 是否生效 |
| api 日志 `remote_unauthorized` | 两边密钥 | `XIANYU_SLIDER_REMOTE_SECRET` 与 `SOLVER_SECRET` 不一致 |
| `real_mouse_available: false` | 是否在交互式桌面会话里 | 用桌面登录的用户启动；RDP 断开后仍可用，但锁屏/服务会话不行 |
| 求解时 Chrome 弹到前台约 1–3 秒并接管鼠标 | 正常现象 | 不要在那几秒动鼠标 |
| 通过率下降 | `logs/solver_*.log` | 轨迹样本是原作者录的，换分辩率可能受影响；可用上游项目的录制脚本重录 `human_trails/` |

## 六、文件说明

| 文件 | 作用 |
| --- | --- |
| `service.py` | FastAPI 服务：鉴权、串行锁、统计、`/health`、`/api/v1/captcha/slider-solve` |
| `start.ps1` | 读 `.env`，用 `.venv` 启动 service.py |
| `tunnel.ps1` | 反向隧道保活循环 |
| `run-detached.ps1` | 以隐藏进程同时拉起上面两个 |
| `probe.py` | 本机手工探测脚本 |
| `common/services/captcha/` | 真人鼠标引擎（AGPL-3.0，见 NOTICE.md） |
| `pyproject.toml` | Python 依赖声明 |
