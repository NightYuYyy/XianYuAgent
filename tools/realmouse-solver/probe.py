"""手动调用一次求解服务，用于联调。

用法：
    python probe.py <punish_url> [cookies_str] [account_id]
环境变量 SOLVER_SECRET / SOLVER_PORT 与服务一致。
"""
import json
import os
import sys
import urllib.request

url = sys.argv[1] if len(sys.argv) > 1 else ""
cookies = sys.argv[2] if len(sys.argv) > 2 else ""
account = sys.argv[3] if len(sys.argv) > 3 else "probe"
port = os.environ.get("SOLVER_PORT", "18095")
payload = {
    "secret_key": os.environ.get("SOLVER_SECRET", ""),
    "account_id": account,
    "url": url,
    "browser_timeout": 60,
    "cookies": cookies,
}
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/v1/captcha/slider-solve",
    data=json.dumps(payload).encode(),
    headers={"content-type": "application/json"},
)
with urllib.request.urlopen(req, timeout=180) as resp:
    body = json.loads(resp.read())
if body.get("success"):
    body["data"]["cookies"] = {k: v[:12] + "..." for k, v in body["data"]["cookies"].items()}
print(json.dumps(body, ensure_ascii=False, indent=2))
