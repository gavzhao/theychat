#!/usr/bin/env bash
# =============================================================================
# W1 基准环境准备（目标：Jetson Orin NX 16GB / JetPack）
#
# !!! 本脚本【未在目标硬件上实测】!!!
# - JetPack 版本未定（README 中 TODO 待回填），pip wheel index / 引擎构建 flag
#   均为按公开文档起草的草稿，需在目标机核对后执行；
# - 所有重型步骤（模型下载 / 引擎构建）默认先人工确认（--yes 可跳过确认），
#   失败报错均标注「目标机验证 TODO」。
#
# 用法：
#   bash setup_env.sh [--stage all|power|deps|models|trtllm|mlc] \
#        [--models-dir DIR] [--yes] [--skip-power] [-h]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${SCRIPT_DIR}/logs"
MODELS_DIR="${HOME}/w1-models"
STAGE="all"
ASSUME_YES=0
SKIP_POWER=0
# MLC 权重编码：规格要求 INT8；MLC 常见编码为 q0f16/q4f16_ft/fp8 等，
# INT8 编码对这三款 VLM 是否可用【未核实】——目标机跑
# `mlc_llm convert_weight --help` 后回填，并同步修改 CSV quant 列口径。
MLC_QUANT="${MLC_QUANT:-q0f16}"

declare -A MODEL_HF=(
  [qwen2vl]="Qwen/Qwen2-VL-2B-Instruct"
  [internvl2]="OpenGVLab/InternVL2-2B"
  [smolvlm2]="HuggingFaceTB/SmolVLM2-2.2B-Instruct"
)
MODEL_KEYS=(qwen2vl internvl2 smolvlm2)

log() { echo "[setup_env $(date '+%F %T')] $*"; }
warn() { echo "[setup_env WARN] $*" >&2; }
die() { echo "[setup_env FATAL] $*" >&2; exit 1; }
step() { echo; echo "========== [setup_env] $* =========="; }

is_jetson() { [[ -r /etc/nv_tegra_release ]]; }

confirm_or_skip() {
  local desc="$1" ans=""
  if [[ "$ASSUME_YES" == "1" ]]; then
    log "--yes 已指定，自动确认：$desc"
    return 0
  fi
  if read -r -p "$desc [y/N] " ans </dev/tty 2>/dev/null; then
    case "$ans" in y|Y|yes|YES) return 0 ;; esac
  fi
  warn "已跳过该步骤（如需免确认执行，加 --yes）：$desc"
  return 1
}

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

# ---------------------------------------------------------------- 参数解析
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) STAGE="${2:?--stage 需要值}"; shift 2 ;;
    --models-dir) MODELS_DIR="${2:?--models-dir 需要值}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --skip-power) SKIP_POWER=1; shift ;;
    -h|--help) usage ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

case "$STAGE" in
  all|power|deps|models|trtllm|mlc) ;;
  *) die "--stage 只支持 all|power|deps|models|trtllm|mlc，收到: $STAGE" ;;
esac
[[ -n "$MODELS_DIR" ]] || die "--models-dir 不能为空"

mkdir -p "$LOG_DIR" "$MODELS_DIR"

run_stage() {
  local want="$1"
  [[ "$STAGE" == "all" || "$STAGE" == "$want" ]]
}

# =============================================================================
stage_power() {
  step "功耗模式：MAXN（nvpmodel -m 0 + jetson_clocks --fan）"
  if ! is_jetson; then
    warn "当前不是 Jetson 环境（缺 /etc/nv_tegra_release），跳过功耗设置 —— 目标机验证 TODO"
    return 0
  fi
  {
    echo "== 设置前 nvpmodel =="; nvpmodel -q 2>&1 || echo "(nvpmodel 不可用，需 sudo/目标机验证)"
    echo "== 设置前 jetson_clocks =="; jetson_clocks --query 2>&1 | head -n 15 || true
  } > "${LOG_DIR}/power_state_before.txt" || true
  log "设置前状态已记录：${LOG_DIR}/power_state_before.txt"
  if [[ "$SKIP_POWER" == "1" ]]; then
    warn "--skip-power：仅记录状态，不切 MAXN"
    return 0
  fi
  sudo nvpmodel -m 0 || die "nvpmodel -m 0 失败 —— TODO 目标机验证：需要 sudo；用 nvpmodel -q 确认模式 0 名称是否为 MAXN"
  sudo jetson_clocks --fan || die "jetson_clocks --fan 失败 —— TODO 目标机验证：确认 jetson_clocks 存在且当前模式支持定频"
  {
    echo "== 设置后 nvpmodel =="; nvpmodel -q 2>&1 || true
    echo "== 设置后 jetson_clocks =="; jetson_clocks --query 2>&1 | head -n 15 || true
  } > "${LOG_DIR}/power_state_after.txt" || true
  log "设置后状态已记录：${LOG_DIR}/power_state_after.txt"
}

# =============================================================================
stage_deps() {
  step "系统依赖（TODO 目标机验证：JetPack 版本决定 pip index）"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y python3-pip python3-dev git curl \
      || warn "apt 安装基础依赖失败 —— 目标机验证 TODO（网络/源）"
  else
    warn "非 apt 环境，跳过系统依赖安装 —— 目标机验证 TODO"
  fi
  pip3 install -U pip setuptools wheel
  pip3 install -U "huggingface_hub[cli]" \
    || die "huggingface-cli 安装失败 —— TODO 目标机验证（pip 源/网络）"

  step "安装 TensorRT-LLM（TODO 目标机验证：版本与 index 随 JetPack 变化）"
  # Jetson 常规路径：Jetson AI Lab 预编译 wheel（JP6 示例 index 见下）；
  # JP5 或无对应 wheel 时需源码编译 —— 以 NVIDIA/Jetson AI Lab 官方文档为准。
  # TODO(JetPack 版本待回填): 回填后核对 cu1xx 与 TRT-LLM 版本号。
  pip3 install --no-cache-dir "tensorrt-llm" \
       --extra-index-url "https://pypi.jetson-ai-lab.dev/jp6/cu126" \
    || die "TensorRT-LLM 安装失败 —— TODO 目标机验证：1) 用 cat /etc/nv_tegra_release 确认 L4T/JetPack 版本；2) 换对应 jp5/jp6 wheel index；3) 仍失败则按官方文档源码编译"

  step "安装 MLC-LLM（TODO 目标机验证：aarch64 wheel 可用性 / vision 模型支持）"
  # 路径 A：prebuilt wheel（Jetson AI Lab / mlc.ai）；路径 B：源码编译
  #   git clone --recursive https://github.com/mlc-ai/relax.git tvm
  #   cd tvm && mkdir build && cd build && cmake .. -DUSE_CUDA=/usr/local/cuda && make -j$(nproc)
  #   git clone https://github.com/mlc-ai/mlc-llm.git && cd mlc-llm && pip install -e .
  # 两条路径都以 mlc-llm 官方 install 文档为目标机核对。
  pip3 install --no-cache-dir mlc-llm \
    || die "MLC-LLM 安装失败 —— TODO 目标机验证：1) 先试 Jetson AI Lab 的 aarch64 prebuilt wheel；2) 退回路径 B 源码编译（TVM/relax + mlc-llm）；3) 确认其对 Qwen2-VL/InternVL2/SmolVLM2 的 vision 支持范围"
  pip3 install --no-cache-dir pillow || warn "pillow 安装失败（可选，gen_fixtures 会退化到纯标准库 PNG）"
}

# =============================================================================
stage_models() {
  step "下载三个候选模型（HuggingFace -> ${MODELS_DIR}/<key>/hf）"
  if ! command -v huggingface-cli >/dev/null 2>&1; then
    die "未找到 huggingface-cli —— 先执行 --stage deps（TODO 目标机验证：pip3 install 'huggingface_hub[cli]'）"
  fi
  for key in "${MODEL_KEYS[@]}"; do
    local dest="${MODELS_DIR}/${key}/hf"
    mkdir -p "$dest"
    if compgen -G "${dest}/*.safetensors" >/dev/null; then
      log "已存在权重，跳过下载：${key} -> $dest"
      continue
    fi
    log "下载 ${MODEL_HF[$key]} -> $dest"
    huggingface-cli download "${MODEL_HF[$key]}" --local-dir "$dest" \
      || die "下载失败：${MODEL_HF[$key]} —— TODO 目标机验证：1) 网络/代理；2) 必要时 HF_ENDPOINT=https://hf-mirror.com；3) gated 仓库先 huggingface-cli login"
  done
  log "全部模型就绪：$(find "$MODELS_DIR" -maxdepth 3 -name '*.safetensors' | wc -l) 个 safetensors"
}

# =============================================================================
# TRT-LLM INT8 引擎构建（草稿命令 —— 目标机验证 TODO，先人工核对再放行）
# 说明：TRT-LLM 对 VLM（Qwen2-VL / InternVL2 / SmolVLM2）的量化与构建入口
# 随版本差异较大：新版走 ModelOpt quantize + trtllm-build；部分 VLM 需要用
# repo 内 examples/multimodal（或对应模型目录）的专用脚本，vision encoder
# 可能单独构建。下面按通用两步起草，逐模型执行。
build_trtllm_engine() {
  local key="$1"
  local hf_dir="${MODELS_DIR}/${key}/hf"
  local ckpt_dir="${MODELS_DIR}/${key}/trtllm_ckpt_int8"
  local eng_dir="${MODELS_DIR}/${key}/trtllm_engine_int8"
  step "TRT-LLM INT8 引擎构建：${key}（草稿命令，先人工核对）"
  [[ -d "$hf_dir" ]] || die "缺少模型目录 $hf_dir —— 先执行 --stage models"
  confirm_or_skip "TRT-LLM 构建命令为草稿，确认已核对官方文档？" || return 0
  # 步骤 1：INT8 量化（ModelOpt int8_sq；校准集参数按需补齐）
  python3 -m tensorrt_llm.tools.quantize \
      --model_dir "$hf_dir" \
      --qformat int8_sq \
      --output_dir "$ckpt_dir" \
    || die "${key}: 量化失败 —— TODO 目标机验证：该 TRT-LLM 版本是否支持 python3 -m tensorrt_llm.tools.quantize；VLM 是否需要 examples 专用量化脚本；int8_sq 校准数据集参数"
  # 步骤 2：引擎编译（max_* 按显存/场景调整）
  trtllm-build --checkpoint "$ckpt_dir" \
      --output_dir "$eng_dir" \
      --gemm_plugin float16 \
      --max_batch_size 4 \
      --max_input_len 1024 \
      --max_seq_len 1280 \
      --max_num_tokens 2048 \
    || die "${key}: trtllm-build 失败 —— TODO 目标机验证：flag 集随版本变化；vision encoder 是否需单独构建（examples/multimodal 等）；显存是否超 16GB 上限"
  log "TRT-LLM 引擎产出：$eng_dir"
}

stage_trtllm() {
  step "TRT-LLM 引擎构建（3 模型 × INT8）"
  if ! command -v python3 >/dev/null 2>&1; then
    die "未找到 python3 —— 先执行 --stage deps"
  fi
  if ! python3 -c "import tensorrt_llm" 2>/dev/null; then
    die "未检测到 tensorrt_llm 包 —— 先执行 --stage deps（TODO 目标机验证安装路径）"
  fi
  for key in "${MODEL_KEYS[@]}"; do
    build_trtllm_engine "$key"
  done
}

# =============================================================================
# MLC-LLM 权重转换 + 编译（草稿命令 —— 目标机验证 TODO）
# 规格要求 INT8，但 MLC 常用编码（q0f16 / q4f16_ft / fp8*）中是否有适用于
# 这三款 VLM 的 INT8 编码【未核实】：目标机跑 `mlc_llm convert_weight --help`
# 后回填 MLC_QUANT，并同步修改 CSV quant 列口径与 README。
build_mlc_model() {
  local key="$1"
  local hf_dir="${MODELS_DIR}/${key}/hf"
  local out_dir="${MODELS_DIR}/${key}/mlc"
  step "MLC-LLM 转换+编译：${key}（quant=${MLC_QUANT}，草稿命令）"
  [[ -d "$hf_dir" ]] || die "缺少模型目录 $hf_dir —— 先执行 --stage models"
  confirm_or_skip "MLC 命令与 ${MLC_QUANT} 编码为草稿，确认已核对官方文档？" || return 0
  if ! command -v mlc_llm >/dev/null 2>&1; then
    die "未找到 mlc_llm —— 先执行 --stage deps（TODO 目标机验证安装路径）"
  fi
  mlc_llm convert_weight "$hf_dir" --quantization "$MLC_QUANT" -o "$out_dir" \
    || die "${key}: convert_weight 失败 —— TODO 目标机验证：${MLC_QUANT} 对该 VLM 是否可用（先跑 mlc_llm convert_weight --help 核对编码列表）；规格要求 INT8，若不可用需团队确认替代档位并回填 MLC_QUANT 与 CSV quant 列"
  mlc_llm gen_config "$hf_dir" --quantization "$MLC_QUANT" -o "$out_dir" \
    || die "${key}: gen_config 失败 —— TODO 目标机验证（mlc-llm 版本相关命令差异）"
  # 显式编译 model lib；若目标机版本支持 serve 时 JIT，可注释此步
  mlc_llm compile "$out_dir" --device cuda -o "${out_dir}/${key}-${MLC_QUANT}.so" \
    || die "${key}: compile 失败 —— TODO 目标机验证：可改用 serve 时 JIT；交叉检查 TVM/relax 版本匹配"
  log "MLC 产出：$out_dir（model lib: ${key}-${MLC_QUANT}.so）"
}

stage_mlc() {
  step "MLC-LLM 权重转换 + 编译（3 模型，quant=${MLC_QUANT}）"
  for key in "${MODEL_KEYS[@]}"; do
    build_mlc_model "$key"
  done
}

# =============================================================================
log "W1 基准环境准备开始：stage=${STAGE} models_dir=${MODELS_DIR} yes=${ASSUME_YES}"
if is_jetson; then
  log "Jetson 检测：$(head -n1 /etc/nv_tegra_release)"
else
  warn "当前不是 Jetson 环境 —— 本脚本所有联网/构建步骤都应只在目标机上执行"
fi

run_stage power  && stage_power
run_stage deps   && stage_deps
run_stage models && stage_models
run_stage trtllm && stage_trtllm
run_stage mlc    && stage_mlc

echo
log "完成（stage=${STAGE}）。下一步："
log "  1) python3 gen_fixtures.py                      # 生成占位图集与指令集"
log "  2) bash run_benchmark.sh --runs 30 --engine both --model all --out results.csv"
log "  3) python3 judge.py --input results.csv --out summary.md"
log "提示：本脚本未在目标硬件实测，所有 TODO(目标机验证) 项首跑需人工盯版。"
