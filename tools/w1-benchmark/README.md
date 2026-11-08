# W1 基准测试脚本包（Jetson Orin NX 16GB · 3×2B VLM × 2 引擎）

> ⚠️⚠️ **本包未在 Orin 目标硬件上实测，首跑需人工盯版。**
> 所有脚本仅通过了语法校验（`bash -n` / `python -m py_compile`）与本地功能烟测；
> 引擎安装、INT8 引擎构建、服务启动命令均为按公开文档起草的**草稿**，
> 凡标注 `TODO(目标机验证)` 之处必须在目标机上核对后再执行。

## 用途

对 3 个候选 2B VLM × 2 个推理引擎做本地推理基准，产出 `results.csv`（逐次原始值）与
`summary.md`（聚合 + 裁决），供团队裁决桌面抓取场景的 VLM 选型：

| 维度 | 候选 |
|---|---|
| 模型 ×3 | Qwen2-VL-2B-Instruct / InternVL2-2B / SmolVLM2-2.2B-Instruct |
| 量化 | INT8（MLC 的 INT8 编码可用性未核实，见 TODO 表） |
| 引擎 ×2 | TensorRT-LLM（trtllm）/ MLC-LLM（mlc） |
| 输入集 | 10 张固定图片 × 10 条固定中文指令（桌面抓取域） |
| 流程 | 每个 (model, engine)：冷启动 1 次（丢弃，run_idx=0）+ 热运行 N=30 次（可参数化） |

## 前置条件

| 项目 | 要求 | 状态 |
|---|---|---|
| 硬件 | Jetson Orin NX 16GB | TODO：**JetPack 版本未定，目标机跑 `cat /etc/nv_tegra_release` 与 `dpkg -l nvidia-jetpack` 后回填此处** |
| 功耗模式 | MAXN（`sudo nvpmodel -m 0 && sudo jetson_clocks --fan`，setup_env.sh 会设置并记录前后状态） | 待目标机验证 |
| 采集工具 | `tegrastats`（**Jetson 无 nvidia-smi，勿换工具**）；`nvpmodel`；`curl`；`python3` | 待目标机验证 |
| 网络 | 能访问 HuggingFace（必要时 `HF_ENDPOINT=https://hf-mirror.com`） | - |
| 权限 | sudo（nvpmodel/jetson_clocks/apt） | - |

## 快速开始

```bash
cd tools/w1-benchmark

# 1) 环境准备（可分阶段：--stage power|deps|models|trtllm|mlc，默认 all）
bash setup_env.sh --stage all --models-dir ~/w1-models --yes

# 2) 生成 10 张占位测试图 + prompts.txt（正式图集由人类替换，文件名/尺寸保持一致）
python3 gen_fixtures.py --out-dir fixtures --size 1280x720

# 3) 跑基准：双引擎 × 三模型，冷启动 1 次丢弃 + 30 次热运行
bash run_benchmark.sh --runs 30 --engine both --model all --out results.csv

# 4) 聚合裁决 -> summary.md
python3 judge.py --input results.csv --out summary.md --latency ttft
```

### 参数速查（与脚本实际实现一致）

**setup_env.sh**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--stage all\|power\|deps\|models\|trtllm\|mlc` | `all` | 分阶段执行；重型构建步骤默认交互确认 |
| `--models-dir DIR` | `~/w1-models` | 模型与引擎产物根目录 |
| `--yes` | 关 | 免交互确认（构建命令为草稿，确认前先人工核对） |
| `--skip-power` | 关 | 只记录 nvpmodel/jetson_clocks 状态，不切 MAXN |

**gen_fixtures.py**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--out-dir DIR` | `<脚本目录>/fixtures` | 输出目录 |
| `--size WxH` | `1280x720` | 占位图尺寸 |

**run_benchmark.sh**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--runs N` | `30` | 热运行次数（冷启动 1 次固定丢弃，run_idx=0） |
| `--engine trtllm\|mlc\|both` | `both` | 引擎选择 |
| `--model all\|qwen2vl\|internvl2\|smolvlm2` | `all` | 模型选择（也接受完整 HF 名） |
| `--out results.csv` | `<脚本目录>/results.csv` | 结果 CSV（已存在则续写追加） |
| `--models-dir DIR` | `~/w1-models` | 模型/引擎产物目录 |
| `--max-tokens 64` | `64` | 每次生成的最大 token |
| `--cooldown 1.0` | `1.0` | 两次热运行间隔秒 |
| `--trtllm-port 9001` / `--mlc-port 9002` | 9001/9002 | 引擎服务端口（刻意避开 8000） |
| `--ready-timeout 300` | `300` | 服务就绪等待秒数 |
| 环境变量 `W1_SERVE_MODEL_NAME` | 未设 | 强制指定 API 的 model 名（默认按 HF 名，TODO 以 /v1/models 为准） |

**judge.py**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--input results.csv`（或位置参数） | `<脚本目录>/results.csv` | 输入 raw CSV |
| `--out summary.md` | 与输入同目录 `summary.md` | 聚合报告输出 |
| `--latency ttft\|total` | `ttft` | 过线判定用哪个延迟口径（报告两种都给） |

## 数据 schema（w1-results.header.csv）

`model,engine,quant,prompt_id,img_id,run_idx,ttft_ms,total_infer_ms,peak_mem_mb,gpu_util_pct,power_w,jetpack_ver,notes`

- **raw CSV 只存逐次原始值**；p50/p95 是聚合值，只出现在 judge.py 生成的 summary.md，不进 raw 行。
- `run_idx=0` 为冷启动行（notes 含 `cold_start_discard`），judge.py 剔除不统计。
- `ttft_ms` = 请求发出 → 首段文本输出（首个 content 增量）；`total_infer_ms` = 完整响应结束；两者都逐次记录（w1_client.py 流式计时）。
- `peak_mem_mb / gpu_util_pct / power_w`：tegrastats `--logfile` 采样后取单次运行内的最大值
  （`RAM x/yMB` 取 x 最大、`GR3D_FREQ n%` 取最大、`VDD_IN n mW` 折算瓦特取最大）。
  注意：Orin 为统一内存，tegrastats 的 RAM 近似整机在用内存（含系统基线），严格的
  「引擎占用显存」口径 TODO 目标机核对；**Jetson 无 nvidia-smi，勿换工具**。
- `quant` 固定写 `int8`（规格）；若 MLC 实际编码非 INT8（见 TODO 表），需团队确认后统一改口径。
- 图片/指令配对：run k 使用 `desktop_{(k-1) mod 10}` × prompts 第 `{(k-1) mod 10}+1` 条（N=30 即 10 个固定配对各测 3 次）。

## 判定逻辑（judge.py，频道 #63 阈值，勿偏离）

1. 按 (model, engine) 分组：P50/P95 延迟（线性插值分位数）、峰值内存取组内最大、
   power/GPU util 取组内最大；失败行不计入延迟分位但计入 fail 计数与内存峰值。
2. 过线 = **P95 ≤ 500ms 且 峰值内存 ≤ 6144MB（6GB）**；缺内存采样视为不过线（判「数据不足/未过线」）。
3. 双引擎全过线 → 选维护成本低者（**标注 MLC**）；单引擎过线 → 选过线者；
   全部未过线 → **建议降 1B 档**（summary.md 自动给出该结论）。
4. `--latency` 切换 P95 口径：默认 TTFT（首字延迟，贴合桌面助手体感）；`total` 为完整响应口径。

## 目录结构

```
tools/w1-benchmark/
├── README.md               # 本文件
├── setup_env.sh            # 环境准备：MAXN/依赖/模型下载/双引擎 INT8 构建
├── gen_fixtures.py         # 生成 10 张占位图 + prompts.txt（10 条中文固定指令）
├── run_benchmark.sh        # 主运行器：双引擎×三模型，冷启动丢弃+N 次热运行
├── w1_client.py            # 辅助：OpenAI 兼容流式计时客户端（仅标准库）
├── judge.py                # 聚合裁决：results.csv -> summary.md（仅标准库）
├── w1-results.header.csv   # raw CSV 表头（13 列）
├── fixtures/               # [生成] desktop_00..09.png + prompts.txt（正式图集由人类替换）
├── logs/                   # [生成] tegrastats 采样、客户端原始输出、服务日志、环境快照
├── results.csv             # [生成] raw 结果
└── summary.md              # [生成] judge.py 裁决报告（不预置）
```

## TODO 清单（目标机验证项）

1. **JetPack 版本回填**：`cat /etc/nv_tegra_release`、`dpkg -l nvidia-jetpack` → 回填本 README 前置条件表。
2. **TensorRT-LLM 安装路径**：JP5/JP6 对应的 wheel index（草稿用 `pypi.jetson-ai-lab.dev/jp6/cu126`）；VLM（Qwen2-VL/InternVL2/SmolVLM2）在所用版本的量化/构建入口（草稿用 `tensorrt_llm.tools.quantize` + `trtllm-build`，vision encoder 可能需 examples 专用脚本）。
3. **trtllm-serve 服务化**：对 VLM 图像输入（OpenAI 兼容 multimodal）的支持范围；API 认可的 model 名（`/v1/models`）。
4. **MLC-LLM 安装**：aarch64 prebuilt wheel 可用性，否则源码编译（TVM/relax + mlc-llm）；对三款 VLM 的 vision/chat-template 支持。
5. **MLC INT8 编码**：`mlc_llm convert_weight --help` 核对编码列表，确认 INT8 档位并回填 `setup_env.sh` 的 `MLC_QUANT`；若 INT8 不可用，团队确认替代档位并统一改 CSV `quant` 列口径。
6. **tegrastats 字段核对**：目标机跑一次采样，确认 `RAM x/yMB`、`GR3D_FREQ n%`、`VDD_IN xmW` 均出现（run_benchmark.sh 解析正则依赖）；必要时按实际输出调整 parse_tegra_peak。
7. **峰值内存口径**：统一内存下的 RAM 占用 vs 引擎实际显存占用，按团队口径修正。
8. **正式图集替换**：人类把桌面抓取真图放入 `fixtures/`（desktop_00.png..desktop_09.png，尺寸与生成占位图一致），prompts.txt 不变。

## 已知限制

- 占位图为合成桌面 mockup（装了 Pillow 带英文窗口标签，没装则纯几何图形），**VLM 对其的回答不具备业务代表性**，仅用于打通管线与量级摸底。
- 结果 CSV 若同文件多次跑（追加模式），judge.py 会把多轮数据混在同一 (model, engine) 组内统计；正式裁决建议每轮独立 `--out` 文件。
- MLC/TRT-LLM 服务启动失败时，脚本会带着日志路径报错退出，不会静默记假数据。
