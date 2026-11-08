#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""W1 基准：OpenAI 兼容流式客户端（纯标准库）。

对 VLM 服务端发一次带图 chat/completions（stream=true）请求：
- ttft_ms        = 请求发出 -> 首段文本输出（首个 content 增量到达）
- total_infer_ms = 请求发出 -> 完整响应结束（finish_reason / [DONE]）

stdout 固定输出单行 JSON：
  {"ok": true, "ttft_ms": 123.45, "total_infer_ms": 456.78,
   "out_chars": 88, "err": null}
失败时 ok=false 且退出码 1，供 run_benchmark.sh 解析。

用法：
  python3 w1_client.py --url http://127.0.0.1:9001/v1/chat/completions \
      --model Qwen/Qwen2-VL-2B-Instruct --image fixtures/desktop_00.png \
      --prompt "描述这张桌面截图中打开了哪些窗口。" \
      [--max-tokens 64] [--timeout 120]
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.request

MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".bmp": "image/bmp",
    ".webp": "image/webp",
}


def build_payload(model, image_path, prompt, max_tokens):
    ext = os.path.splitext(image_path)[1].lower()
    mime = MIME.get(ext, "image/png")
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    data_uri = "data:%s;base64,%s" % (mime, b64)
    return json.dumps({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_uri}},
                {"type": "text", "text": prompt},
            ],
        }],
        "max_tokens": max_tokens,
        "stream": True,
    }).encode("utf-8")


def delta_text(delta):
    """兼容 content 为字符串或多段列表两种增量格式（MLC/TRT-LLM 行为不一）。"""
    content = delta.get("content")
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for seg in content:
            if isinstance(seg, dict) and isinstance(seg.get("text"), str):
                parts.append(seg["text"])
        return "".join(parts)
    return ""


def run(args):
    payload = build_payload(args.model, args.image, args.prompt, args.max_tokens)
    req = urllib.request.Request(
        args.url, data=payload,
        headers={"Content-Type": "application/json"},
    )
    t0 = time.perf_counter()
    ttft_ms = None
    total_ms = None
    out_chars = 0
    err = None
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue  # SSE 注释/空行
                body = line[len("data:"):].strip()
                if body == "[DONE]":
                    break
                try:
                    obj = json.loads(body)
                except json.JSONDecodeError:
                    continue
                for choice in obj.get("choices", []):
                    text = delta_text(choice.get("delta") or {})
                    if text:
                        if ttft_ms is None:
                            ttft_ms = (time.perf_counter() - t0) * 1000.0
                        out_chars += len(text)
                    if choice.get("finish_reason"):
                        total_ms = (time.perf_counter() - t0) * 1000.0
        if total_ms is None:  # 流被对端关掉但没发 finish_reason
            total_ms = (time.perf_counter() - t0) * 1000.0
    except Exception as exc:  # noqa: BLE001 - 网络/协议错误统一折算为失败行
        err = "%s: %s" % (type(exc).__name__, exc)
    if err is None and ttft_ms is None:
        err = "stream ended without any text delta"
    ok = err is None
    return {
        "ok": ok,
        "ttft_ms": round(ttft_ms, 2) if ttft_ms is not None else None,
        "total_infer_ms": round(total_ms, 2) if total_ms is not None else None,
        "out_chars": out_chars,
        "err": err,
    }


def main():
    ap = argparse.ArgumentParser(description="W1 基准流式计时客户端（仅标准库）")
    ap.add_argument("--url", required=True, help="chat/completions 端点全 URL")
    ap.add_argument("--model", required=True, help="服务端认可的 model 名（TODO 目标机核对）")
    ap.add_argument("--image", required=True, help="输入图片路径")
    ap.add_argument("--prompt", required=True, help="本轮指令文本")
    ap.add_argument("--max-tokens", type=int, default=64)
    ap.add_argument("--timeout", type=float, default=120.0, help="单次请求超时秒数")
    args = ap.parse_args()

    if not os.path.isfile(args.image):
        print(json.dumps({"ok": False, "ttft_ms": None, "total_infer_ms": None,
                          "out_chars": 0, "err": "image not found: %s" % args.image},
                         ensure_ascii=False))
        return 1
    result = run(args)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
