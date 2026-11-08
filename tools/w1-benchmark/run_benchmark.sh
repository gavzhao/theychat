#!/usr/bin/env bash
# =============================================================================
# W1 基准主运行器（Jetson Orin NX 16GB）
#
# !!! 本脚本【未在目标硬件上实测】!!!
# - 双引擎（TensorRT-LLM / MLC-LLM）× 三模型（Qwen2-VL-2B / InternVL2-2B / SmolVLM2-2.2B）
#   逐组合：启动服务 -> 冷启动 1 次（丢弃，run_idx=0）-> 热运行 N 次（默认 30）
# - 每次运行逐次写一行 raw CSV（run_benchmark 不做聚合，聚合见 judge.py）
# - peak_mem_mb / gpu_util_pct / power_w 来自 tegrastats 采样（Jetson 无 nvidia-smi！）
# - 引擎服务的启动命令为草稿，带「目标机验证 TODO」，首跑需人工盯版
#
# 用法：
#   bash run_benchmark.sh [--runs 30] [--engine trtllm|mlc|both] \
#        [--model all|qwen2vl|internvl2|smolvlm2] [--out results.csv] \
#        [--models-dir DIR] [--max-tokens 64] [--cooldown 1.0] \
#        [--trtllm-port 9001] [--mlc-port 9002] [--ready-timeout 300] [-h]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/fixtures"
PROMPTS_FILE="${FIXTURES_DIR}/prompts.txt"
LOG_DIR="${SCRIPT_DIR}/logs"
CLIENT="${SCRIPT_DIR}/w1_client.py"
HEADER="${SCRIPT_DIR}/w1-results.header.csv"

RUNS=30
ENGINE="both"
MODEL="all"
OUT="${SCRIPT_DIR}/results.csv"
MODELS_DIR="${HOME}/w1-models"
MAX_TOKENS=64
COOLDOWN="1.0"
READY_TIMEOUT=300
TRTLLM_PORT=9001
MLC_PORT=9002
TEGRA_INTERVAL=100      # tegrastats 采样间隔 ms
TEGRA_PID=""
SERVER_PID=""

declare -A MODEL_HF=(
  [qwen2vl]="Qwen/Qwen2-VL-2B-Instruct"
  [internvl2]="OpenGVLab/InternVL2-2B"
  [smolvlm2]="HuggingFaceTB/SmolVLM2-2.2B-Instruct"
)
MODEL_KEYS=(qwen2vl internvl2 smolvlm2)
ENGINE_KEYS=(trtllm mlc)

log() { echo "[run_bench $(date '+%F %T')] $*"; }
die() { echo "[run_bench FATAL] $*" >&2; exit 1; }

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

# ---------------------------------------------------------------- 参数解析
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs) RUNS="${2:?--runs 需要值}"; shift 2 ;;
    --engine) ENGINE="${2:?--engine 需要值}"; shift 2 ;;
    --model) MODEL="${2:?--model 需要值}"; shift 2 ;;
    --out) OUT="${2:?--out 需要值}"; shift 2 ;;
    --models-dir) MODELS_DIR="${2:?--models-dir 需要值}"; shift 2 ;;
    --max-tokens) MAX_TOKENS="${2:?--max-tokens 需要值}"; shift 2 ;;
    --cooldown) COOLDOWN="${2:?--cooldown 需要值}"; shift 2 ;;
    --trtllm-port) TRTLLM_PORT="${2:?--trtllm-port 需要值}"; shift 2 ;;
    --mlc-port) MLC_PORT="${2:?--mlc-port 需要值}"; shift 2 ;;
    --ready-timeout) READY_TIMEOUT="${2:?--ready-timeout 需要值}"; shift 2 ;;
    -h|--help) usage ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

[[ "$RUNS" =~ ^[1-9][0-9]*$ ]] || die "--runs 必须为正整数，收到: $RUNS"
[[ "$MAX_TOKENS" =~ ^[1-9][0-9]*$ ]] || die "--max-tokens 必须为正整数，收到: $MAX_TOKENS"
[[ "$READY_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die "--ready-timeout 必须为正整数秒，收到: $READY_TIMEOUT"
[[ "$COOLDOWN" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--cooldown 必须为非负数字（秒），收到: $COOLDOWN"
case "$ENGINE" in trtllm|mlc|both) ;; *) die "--engine 只支持 trtllm|mlc|both，收到: $ENGINE" ;; esac
[[ "$OUT" != "$HEADER" ]] || die "--out 不能指向表头文件 w1-results.header.csv"

# 规范 --model：接受 key（qwen2vl 等）或完整 HF 名
norm_model() {
  local m
  m="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
  local key
  for key in "${MODEL_KEYS[@]}"; do
    [[ "$m" == "$key" ]] && { echo "$key"; return; }
  done
  for key in "${MODEL_KEYS[@]}"; do
    local hf; hf="$(echo "${MODEL_HF[$key]}" | tr '[:upper:]' '[:lower:]')"
    [[ "$m" == "$hf" ]] && { echo "$key"; return; }
  done
  echo ""
}
MODEL_KEY=""
if [[ "$MODEL" != "all" ]]; then
  MODEL_KEY="$(norm_model "$MODEL")"
  [[ -n "$MODEL_KEY" ]] || die "--model 只支持 all|qwen2vl|internvl2|smolvlm2（或完整 HF 名），收到: $MODEL"
fi

command -v python3 >/dev/null 2>&1 || die "未找到 python3"
command -v curl >/dev/null 2>&1 || die "未找到 curl（Jetson: sudo apt-get install -y curl）"
[[ -f "$CLIENT" ]] || die "缺少客户端脚本 $CLIENT"
[[ -f "$HEADER" ]] || die "缺少表头文件 $HEADER"

# ---------------------------------------------------------------- 环境记录
jetpack_version() {
  local v=""
  if command -v dpkg >/dev/null 2>&1; then
    v="$(dpkg -l nvidia-jetpack 2>/dev/null | awk '/^ii/{print $3; exit}')"
  fi
  if [[ -z "$v" && -r /etc/nv_tegra_release ]]; then
    v="L4T-$(sed -n 's/.*R[0-9][0-9]*, REVISION: \([0-9.]*\).*/\1/p' /etc/nv_tegra_release | head -n1)"
  fi
  [[ -z "$v" ]] && v="unknown"
  echo "$v"
}

snapshot_env() {
  local tag="$1" f="${LOG_DIR}/env_${tag}.txt"
  {
    echo "== nvpmodel =="; nvpmodel -q 2>&1 || echo "(nvpmodel 不可用)"
    echo "== jetson_clocks =="; jetson_clocks --query 2>&1 | head -n 15 || true
    echo "== jetpack =="; jetpack_version
  } > "$f" 2>&1 || true
  log "环境状态快照 -> $f"
}

check_maxn() {
  if command -v nvpmodel >/dev/null 2>&1; then
    if nvpmodel -q 2>/dev/null | grep -qi 'MAXN'; then
      log "功耗模式检查：MAXN ✓"
    else
      log "WARN: 当前不是 MAXN —— 先执行: sudo nvpmodel -m 0 && sudo jetson_clocks --fan（或 bash setup_env.sh --stage power）"
    fi
  else
    log "WARN: 未找到 nvpmodel（非 Jetson 环境？），跳过功耗模式检查"
  fi
}

# ---------------------------------------------------------------- tegrastats
# Jetson 无 nvidia-smi！峰值显存/功耗/gpu_util 一律来自 tegrastats。
tegra_start() {
  local f="$1"
  if command -v tegrastats >/dev/null 2>&1; then
    tegrastats --logfile "$f" --interval "$TEGRA_INTERVAL" >/dev/null 2>&1 &
    TEGRA_PID=$!
    sleep 0.3   # 等首个采样点落盘
  else
    TEGRA_PID=""
    log "WARN: 未找到 tegrastats（非 Jetson 环境？）—— 本行 peak_mem/gpu_util/power 将留空"
  fi
}

tegra_stop() {
  if [[ -n "${TEGRA_PID:-}" ]]; then
    kill "${TEGRA_PID}" 2>/dev/null || true
    wait "${TEGRA_PID}" 2>/dev/null || true
    TEGRA_PID=""
  fi
}

parse_tegra_peak() {
  python3 - "$1" <<'PYEOF'
import re, sys
try:
    txt = open(sys.argv[1], "r", errors="replace").read()
except OSError:
    txt = ""
ram = [int(m) for m in re.findall(r"RAM (\d+)/\d+MB", txt)]
util = [int(m) for m in re.findall(r"GR3D_FREQ (\d+)%", txt)]
pw = [int(m) for m in re.findall(r"VDD_IN (\d+)mW", txt)]
print(max(ram) if ram else "")
print(max(util) if util else "")
print(round(max(pw) / 1000.0, 2) if pw else "")
PYEOF
}

# ---------------------------------------------------------------- 服务生命周期
# TODO(目标机验证)：两个引擎的服务化入口/flag 随版本变化，以下为草稿。
# 基准走 OpenAI 兼容流式端点（见 w1_client.py），两引擎只是起服务方式不同。
start_server() {
  local engine="$1" mkey="$2"
  local hf="${MODEL_HF[$mkey]}"
  local logfile="${LOG_DIR}/server_${engine}_${mkey}.log"
  case "$engine" in
    trtllm)
      command -v trtllm-serve >/dev/null 2>&1 \
        || die "未找到 trtllm-serve —— TODO 目标机验证：先跑 setup_env.sh --stage trtllm；若该版本服务化入口不同（python3 -m tensorrt_llm.serve.* / examples/multimodal 自建服务），请改写本函数"
      log "启动 TRT-LLM 服务：${mkey}（TODO 目标机验证启动参数）"
      # TODO(目标机验证)：1) engine/tokenizer 路径按 setup_env.sh 构建产物核对；
      # 2) trtllm-serve 对 VLM 图像输入（OpenAI 兼容 multimodal）支持范围未核实，
      #    若不支持需改用 PyTorch runtime + 自建 SSE 服务，并同步改 w1_client.py 的字段格式。
      trtllm-serve serve "${MODELS_DIR}/${mkey}/trtllm_engine_int8" \
          --tokenizer "${MODELS_DIR}/${mkey}/hf" \
          --host 127.0.0.1 --port "${TRTLLM_PORT}" \
          >"$logfile" 2>&1 &
      SERVER_PID=$!
      ;;
    mlc)
      command -v mlc_llm >/dev/null 2>&1 \
        || die "未找到 mlc_llm —— TODO 目标机验证：先跑 setup_env.sh --stage mlc"
      log "启动 MLC 服务：${mkey}（TODO 目标机验证启动参数）"
      # TODO(目标机验证)：1) --model-lib 指向 setup_env.sh 的编译产物；
      # 2) mlc_llm serve 对这三款 VLM 的 vision 支持（chat template 中 image 占位）未核实；
      # 3) 服务端认可的 model 名以 GET /v1/models 返回为准（下方 wait_ready 后打印）。
      mlc_llm serve "${MODELS_DIR}/${mkey}/mlc" \
          --model-lib "${MODELS_DIR}/${mkey}/mlc/${mkey}-q0f16.so" \
          --mode local \
          --host 127.0.0.1 --port "${MLC_PORT}" \
          >"$logfile" 2>&1 &
      SERVER_PID=$!
      ;;
    *) die "内部错误：未知 engine $engine" ;;
  esac
}

wait_ready() {
  local base_url="$1" label="$2" waited=0
  log "等待服务就绪（${label}）：${base_url}/v1/models，最长 ${READY_TIMEOUT}s ..."
  while ! curl -sf "${base_url}/v1/models" >/dev/null 2>&1; do
    sleep 2
    waited=$((waited + 2))
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
      die "服务进程已退出（${label}）—— 查看日志 ${LOG_DIR}/server_*.log；TODO 目标机验证启动命令"
    fi
    if [[ $waited -ge $READY_TIMEOUT ]]; then
      die "服务 ${READY_TIMEOUT}s 内未就绪（${label}）—— 查看日志 ${LOG_DIR}/server_*.log；TODO 目标机验证启动命令"
    fi
  done
  curl -sf "${base_url}/v1/models" > "${LOG_DIR}/models_${label}.json" 2>/dev/null || true
  log "服务就绪 ✓（/v1/models 已存到 ${LOG_DIR}/models_${label}.json，TODO 目标机核对 model 名）"
}

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    pkill -P "${SERVER_PID}" 2>/dev/null || true
    kill "${SERVER_PID}" 2>/dev/null || true
    local i
    for i in $(seq 1 10); do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -9 "${SERVER_PID}" 2>/dev/null || true
    SERVER_PID=""
    log "服务已停止"
  fi
}

cleanup() {
  tegra_stop || true
  stop_server || true
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# ---------------------------------------------------------------- 结果行
json_field() {
  python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {}
v = d.get(sys.argv[2])
print("" if v is None else v)' "$1" "$2" 2>/dev/null || true
}

append_row() {
  # 13 列，与 w1-results.header.csv 完全一致；notes 去逗号防 CSV 破列
  local model_id="$1" engine="$2" prompt_id="$3" img_id="$4" run_idx="$5" \
        ttft="$6" total="$7" peak="$8" util="$9" power="${10}" notes="${11}"
  notes="${notes//,/ }"
  printf '%s,%s,int8,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$model_id" "$engine" "$prompt_id" "$img_id" "$run_idx" \
    "$ttft" "$total" "$peak" "$util" "$power" "$JETPACK_VER" "$notes" >> "$OUT"
}

do_run() {
  local engine="$1" mkey="$2" run_idx="$3" is_cold="$4"
  local eff=$(( run_idx > 0 ? run_idx - 1 : 0 ))
  local img_idx=$(( eff % IMG_COUNT ))
  local pr_idx=$(( eff % PROMPT_COUNT ))
  local img="${IMG_FILES[$img_idx]}"
  local prompt="${PROMPTS[$pr_idx]}"
  local img_id; img_id="$(basename "$img")"; img_id="${img_id%.*}"
  local prompt_id=$(( pr_idx + 1 ))
  local tag="${engine}_${mkey}_run${run_idx}"
  local ts_log="${LOG_DIR}/tegrastats_${tag}.log"
  local cl_log="${LOG_DIR}/client_${tag}.json"
  local base_url
  case "$engine" in
    trtllm) base_url="http://127.0.0.1:${TRTLLM_PORT}" ;;
    mlc)    base_url="http://127.0.0.1:${MLC_PORT}" ;;
  esac

  tegra_start "$ts_log"
  local rc=0
  python3 "$CLIENT" \
      --url "${base_url}/v1/chat/completions" \
      --model "$SERVE_MODEL_NAME" \
      --image "$img" \
      --prompt "$prompt" \
      --max-tokens "$MAX_TOKENS" \
      >"$cl_log" 2>"${LOG_DIR}/client_${tag}.err" || rc=$?
  tegra_stop

  mapfile -t tp < <(parse_tegra_peak "$ts_log")
  local peak_mb="${tp[0]:-}" util_pct="${tp[1]:-}" power_w="${tp[2]:-}"
  local ttft total ok err notes=""
  ok="$(json_field "$cl_log" ok)"
  ttft="$(json_field "$cl_log" ttft_ms)"
  total="$(json_field "$cl_log" total_infer_ms)"
  err="$(json_field "$cl_log" err)"
  if [[ "$rc" -ne 0 || "$ok" != "True" ]]; then
    notes="client_error: ${err:-(exit ${rc})}"
    ttft=""
    total=""
  fi
  if [[ -z "$peak_mb" ]]; then
    notes="${notes} tegrastats_missing"
  fi
  if [[ "$is_cold" == "yes" ]]; then
    notes="cold_start_discard ${notes}"
  fi
  notes="$(echo "$notes" | xargs)"   # 去首尾空白
  append_row "${MODEL_HF[$mkey]}" "$engine" "$prompt_id" "$img_id" "$run_idx" \
             "$ttft" "$total" "$peak_mb" "$util_pct" "$power_w" "$notes"
  if [[ "$is_cold" == "yes" ]]; then
    log "  [${engine}/${mkey}] 冷启动(run0，丢弃) 已记录：ttft=${ttft:-NA} total=${total:-NA}"
  else
    log "  [${engine}/${mkey}] run ${run_idx}/${RUNS}: ttft=${ttft:-FAIL} total=${total:-FAIL} peak=${peak_mb:-NA}MB pw=${power_w:-NA}W"
  fi
  [[ "$COOLDOWN" == "0" ]] || sleep "$COOLDOWN"
}

# ---------------------------------------------------------------- 主流程
mkdir -p "$LOG_DIR" "$(dirname "$OUT")"

# 图集与指令集检查
if [[ ! -f "$PROMPTS_FILE" ]]; then
  die "缺少 ${PROMPTS_FILE} —— 先运行: python3 gen_fixtures.py"
fi
mapfile -t IMG_FILES < <(find "${FIXTURES_DIR}" -maxdepth 1 -name 'desktop_*.png' 2>/dev/null | sort)
mapfile -t PROMPTS < <(tr -d '\r' < "${PROMPTS_FILE}")
IMG_COUNT="${#IMG_FILES[@]}"
PROMPT_COUNT="${#PROMPTS[@]}"
[[ "$IMG_COUNT" -ge 1 ]] || die "fixtures 下没有 desktop_*.png —— 先运行: python3 gen_fixtures.py（正式图集由人类替换，文件名保持一致）"
[[ "$PROMPT_COUNT" -ge 1 ]] || die "prompts.txt 为空 —— 先运行: python3 gen_fixtures.py"
[[ "$IMG_COUNT" -eq 10 && "$PROMPT_COUNT" -eq 10 ]] \
  || log "WARN: 规格为 10 图 × 10 指令，当前 ${IMG_COUNT} 图 / ${PROMPT_COUNT} 指令，按取模轮转继续"

# 结果文件：新文件则先写表头，已有则续写
if [[ ! -f "$OUT" ]]; then
  cp "$HEADER" "$OUT"
  log "结果文件初始化：$OUT（表头 = w1-results.header.csv）"
else
  log "结果文件已存在，续写追加：$OUT"
fi

JETPACK_VER="$(jetpack_version)"
log "JetPack 版本：${JETPACK_VER}（TODO 目标机核对 dpkg -l nvidia-jetpack 输出）"
snapshot_env pre
check_maxn

# 引擎与模型列表
ENGINES=()
case "$ENGINE" in
  trtllm) ENGINES=(trtllm) ;;
  mlc)    ENGINES=(mlc) ;;
  both)   ENGINES=("${ENGINE_KEYS[@]}") ;;
esac
if [[ -n "$MODEL_KEY" ]]; then
  MODELS=("$MODEL_KEY")
else
  MODELS=("${MODEL_KEYS[@]}")
fi

# 服务端 model 名：TODO 目标机验证 —— 以 /v1/models 返回为准，
# 可用环境变量 W1_SERVE_MODEL_NAME 强制指定（对全部组合生效）。
if [[ -n "${W1_SERVE_MODEL_NAME:-}" ]]; then
  SERVE_MODEL_NAME="$W1_SERVE_MODEL_NAME"
  AUTO_MODEL_NAME=0
else
  SERVE_MODEL_NAME=""
  AUTO_MODEL_NAME=1
fi

log "计划：engines=[${ENGINES[*]}] models=[${MODELS[*]}] runs=${RUNS} out=${OUT}"

for engine in "${ENGINES[@]}"; do
  for mkey in "${MODELS[@]}"; do
    log "=== ${mkey} × ${engine}：开始 ==="
    if [[ "$AUTO_MODEL_NAME" == "1" ]]; then
      SERVE_MODEL_NAME="${MODEL_HF[$mkey]}"
    fi
    start_server "$engine" "$mkey"
    wait_ready "http://127.0.0.1:$([[ "$engine" == trtllm ]] && echo "$TRTLLM_PORT" || echo "$MLC_PORT")" "${engine}_${mkey}"
    do_run "$engine" "$mkey" 0 yes                    # 冷启动 1 次，丢弃
    local_i=1
    while [[ $local_i -le $RUNS ]]; do
      do_run "$engine" "$mkey" "$local_i" no
      local_i=$((local_i + 1))
    done
    stop_server
    log "=== ${mkey} × ${engine}：完成（1 丢弃 + ${RUNS} 热运行已写入 $OUT）==="
  done
done

snapshot_env post
log "全部完成。聚合裁决：python3 judge.py --input $OUT --out $(dirname "$OUT")/summary.md"
log "提醒：引擎启动命令为草稿（目标机验证 TODO），首跑请人工盯版。"
