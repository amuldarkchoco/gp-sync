"""Phone alerts through ntfy (https://ntfy.sh or self-hosted) and Telegram."""

import json
import threading
import urllib.parse
import urllib.request


def channels(cfg):
    """Names of the alert channels that are set up."""
    out = []
    if cfg.get("ntfy_url"):
        out.append("ntfy")
    if cfg.get("telegram_token") and cfg.get("telegram_chat"):
        out.append("telegram")
    return out


def send_now(cfg, title, message, tags="", timeout=15):
    """Send to every configured channel. Returns {channel: "ok" or error text}."""
    results = {}
    if cfg.get("ntfy_url"):
        try:
            headers = {"Title": title.encode("utf-8").decode("latin-1", "replace"), "Tags": tags}
            if cfg.get("ntfy_token"):
                headers["Authorization"] = f"Bearer {cfg['ntfy_token']}"
            req = urllib.request.Request(cfg["ntfy_url"], data=message.encode(), headers=headers, method="POST")
            urllib.request.urlopen(req, timeout=timeout).close()
            results["ntfy"] = "ok"
        except Exception as e:
            results["ntfy"] = f"{type(e).__name__}: {e}"
    if cfg.get("telegram_token") and cfg.get("telegram_chat"):
        try:
            url = f"https://api.telegram.org/bot{urllib.parse.quote(cfg['telegram_token'], safe=':')}/sendMessage"
            body = json.dumps({"chat_id": cfg["telegram_chat"], "text": f"{title}\n{message}"}).encode()
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=timeout).close()
            results["telegram"] = "ok"
        except Exception as e:
            results["telegram"] = f"{type(e).__name__}: {e}"
    return results


def send(cfg, title, message, tags="", on_done=None):
    """Send in the background so alerts never slow down uploads."""

    def run():
        result = send_now(cfg, title, message, tags)
        if on_done:
            on_done(result)

    if channels(cfg):
        threading.Thread(target=run, daemon=True).start()
