#!/usr/bin/env bash
# theychat 冒烟测试：真连 server 的 CLI 全链路（profile/channel/send/recv/ack/cursor/file roundtrip）
set -e
cd "$(dirname "$0")"
SMOKE=.smoke-tmp
mkdir -p "$SMOKE/files"

# 若 8020 已有残留进程，先清理
oldpid=$(netstat -ano 2>/dev/null | grep ':8020' | grep LISTENING | awk '{print $5}' | head -1)
if [ -n "$oldpid" ]; then taskkill //PID "$oldpid" //F >/dev/null 2>&1 || true; fi

DATABASE_URL='postgres://theychat:theychat@127.0.0.1:55432/theychat' \
THEYCHAT_PORT=8020 THEYCHAT_HOST=127.0.0.1 THEYCHAT_FILES_DIR="$SMOKE/files" \
  node theychat-backend/src/server.js > "$SMOKE/serve.log" 2>&1 &
SPID=$!
trap 'kill $SPID 2>/dev/null || true' EXIT

curl -s --retry 30 --retry-delay 1 --retry-connrefused http://127.0.0.1:8020/healthz && echo " <- healthz OK"

CLI="node theychat-cli/src/main.js"
$CLI profile add smoke-a --server http://127.0.0.1:8020 --display-name alice
$CLI profile add smoke-b --server http://127.0.0.1:8020 --display-name bob
echo "--- create + send ---"
$CLI --profile smoke-a channel create dev
$CLI --profile smoke-a send dev "hello from alice"
echo "--- channels (bob 视角) ---"
$CLI --profile smoke-b channels
echo "--- recv --no-ack --from-start ---"
$CLI --profile smoke-b recv dev --no-ack --from-start
echo "--- ack + cursor ---"
$CLI --profile smoke-b ack dev --through 1
$CLI --profile smoke-b cursor dev
echo "--- file roundtrip ---"
printf 'smoke file roundtrip\n' > "$SMOKE/f.txt"
$CLI --profile smoke-a send dev --file "$SMOKE/f.txt" "the file"
$CLI --profile smoke-b download dev 2 -o "$SMOKE/dl.txt"
cmp "$SMOKE/f.txt" "$SMOKE/dl.txt" && echo "FILE_ROUNDTRIP_OK"
echo "=== serve.log tail ==="
tail -5 "$SMOKE/serve.log" || true
