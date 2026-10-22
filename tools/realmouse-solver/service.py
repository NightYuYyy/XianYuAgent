"""闲鱼真人鼠标滑块求解小服务（Windows 专用）。

把 zhinianboke/xianyu-auto-reply 的 real_mouse 引擎单独拎出来，用一个 HTTP 接口暴露，
协议与它自己的远程打码接口 `/api/v1/captcha/slider-solve` 一致，所以服务器上的
xianyu-auto-reply 在「风控日志 → 远程配置」里填本服务地址即可直接使用；
XianYuAgent 之类的其他项目按同一协议调用即可。

请求（POST JSON）:
    secret_key      调用密钥（与 SOLVER_SECRET 一致）
    account_id      账号标识，仅用于日志与排队
    url             punish 验证链接
    browser_timeout 单次浏览器超时秒数（默认 60）
    cookies         可选，账号 Cookie 字符串；带上才能把 x5sec 绑定到账号
    device_id       可选，暂未使用

响应:
    {"success": true,  "data": {"cookies": {"x5sec": "..."}}}
    {"success": false, "message": "...", "data": {"url_expired": true}}   # 链接过期，调用方刷新后重试
    {"success": false, "message": "..."}
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)  # real_mouse_slider 用相对路径找 human_trails / browser_data

from common.services.captcha.real_mouse_slider import (  # noqa: E402
    REAL_MOUSE_AVAILABLE,
    run_real_mouse_verification,
)
from common.services.captcha.slider_stealth import CAPTCHA_NOT_REQUIRED, URL_EXPIRED  # noqa: E402

SECRET = os.environ.get("SOLVER_SECRET", "").strip()
HOST = os.environ.get("SOLVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("SOLVER_PORT", "18095"))
MAX_TIMEOUT = int(os.environ.get("SOLVER_MAX_BROWSER_TIMEOUT", "120"))

if not SECRET:
    raise SystemExit("请先设置环境变量 SOLVER_SECRET（调用密钥）")

logger.remove()
logger.add(sys.stderr, level=os.environ.get("SOLVER_LOG_LEVEL", "INFO"))
logger.add(ROOT / "logs" / "solver_{time:YYYY-MM-DD}.log", rotation="1 day", retention="14 days", level="INFO", encoding="utf-8")

app = FastAPI(title="xianyu-realmouse-solver", docs_url=None, redoc_url=None)

# 物理鼠标只有一个，引擎内部已经串行；这里再加一把锁，避免并发请求堆在引擎的线程池里。
_solve_lock = threading.Lock()
_stats = {"requests": 0, "success": 0, "failed": 0, "url_expired": 0, "last_result_at": None}


class SolveRequest(BaseModel):
    secret_key: str = ""
    account_id: str = ""
    url: str = ""
    browser_timeout: int = 60
    cookies: str = ""
    device_id: str = ""


def _fail(message: str, status: int = 200, **data):
    return JSONResponse({"success": False, "message": message, "data": data or None}, status_code=status)


@app.get("/health")
def health():
    return {"status": "ok", "real_mouse_available": REAL_MOUSE_AVAILABLE, "platform": sys.platform, **_stats}


@app.post("/api/v1/captcha/slider-solve")
def slider_solve(body: SolveRequest, request: Request):
    if body.secret_key != SECRET:
        logger.warning(f"拒绝未授权调用: {request.client.host if request.client else '?'}")
        return _fail("秘钥错误", status=401)
    if not body.url or "punish" not in body.url:
        return _fail("url 不是有效的 punish 验证链接")
    if not REAL_MOUSE_AVAILABLE:
        return _fail("真实鼠标引擎不可用（仅支持 Windows 桌面环境）")

    timeout = max(20, min(int(body.browser_timeout or 60), MAX_TIMEOUT))
    account = body.account_id or "unknown"
    _stats["requests"] += 1
    logger.info(f"【{account}】收到滑块请求 timeout={timeout}s cookies={'有' if body.cookies else '无'} from={request.client.host if request.client else '?'}")

    started = time.time()
    with _solve_lock:
        ok, cookies = run_real_mouse_verification(
            user_id=account,
            url=body.url,
            existing_cookies_str=body.cookies or "",
            browser_timeout=timeout,
            weight_class="remote_cookie" if body.cookies else "remote",
        )
    elapsed = round(time.time() - started, 1)
    _stats["last_result_at"] = time.strftime("%Y-%m-%d %H:%M:%S")

    if ok and cookies:
        _stats["success"] += 1
        logger.success(f"【{account}】滑块通过，用时 {elapsed}s，返回 cookie: {list(cookies.keys())}")
        return {"success": True, "message": "ok", "data": {"cookies": cookies}}

    # 引擎失败时第二个返回值可能是哨兵字符串而不是 dict
    if cookies == URL_EXPIRED:
        _stats["url_expired"] += 1
        logger.warning(f"【{account}】验证链接已过期（{elapsed}s）")
        return _fail("验证链接已过期", url_expired=True)
    if cookies == CAPTCHA_NOT_REQUIRED:
        logger.info(f"【{account}】打开链接后发现无需验证（{elapsed}s）")
        return _fail("无需验证")

    _stats["failed"] += 1
    logger.warning(f"【{account}】滑块未通过（{elapsed}s）")
    return _fail("滑块验证未通过")


if __name__ == "__main__":
    import uvicorn

    logger.info(f"xianyu-realmouse-solver 启动 http://{HOST}:{PORT} real_mouse_available={REAL_MOUSE_AVAILABLE}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
