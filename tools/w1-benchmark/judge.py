#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""W1 基准裁决器：results.csv -> summary.md（聚合表 + 过线判定 + 推荐）。

仅用 Python 标准库（csv/statistics 级别，不引入 pandas）。

裁决阈值（来自频道 #63，勿改）：
- P95 延迟 <= 500 ms 且 峰值内存 <= 6144 MB（6GB） -> 该 (model, engine) 过线
- 双引擎全过线 -> 选维护成本低者（标注 MLC）
- 单引擎过线   -> 选过线者
- 全部未过线   -> 建议降 1B 档

说明：
- run_idx=0（冷启动丢弃行）与 notes 含 cold_start_discard 的行不参与统计；
- 失败行（ttft/total 为空）不计入延迟分位数，但计入 fail 计数；
  其 peak_mem 若有值仍参与峰值内存统计（显存压力与推理成败无关）；
- p50/p95 为聚合值，raw CSV 中不存（raw 只存逐次原始值）。

用法：
  python3 judge.py --input results.csv --out summary.md [--latency ttft|total]
"""
import argparse
import csv
import datetime
import os
import sys

THRESH_P95_MS = 500.0
THRESH_PEAK_MEM_MB = 6144.0
COLD_NOTES_MARK = "cold_start_discard"

COLUMNS = ["model", "engine", "quant", "prompt_id", "img_id", "run_idx",
           "ttft_ms", "total_infer_ms", "peak_mem_mb", "gpu_util_pct",
           "power_w", "jetpack_ver", "notes"]


def percentile(sorted_vals, q):
    """线性插值分位数；空列表返回 None。"""
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    pos = (len(sorted_vals) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = pos - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def fnum(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    return v if v == v else None  # 排除 NaN


def fmt(v, nd=1):
    return ("-" if v is None else ("%.*f" % (nd, v)))


def load_rows(path):
    bad = 0
    rows = []
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        missing = [c for c in COLUMNS if c not in header]
        if missing:
            print("WARN: 表头缺少列 %s，按可解析行继续" % missing, file=sys.stderr)
        for r in reader:
            if not any((v or "").strip() for v in r.values()):
                continue
            if any(r.get(c) is None for c in COLUMNS):
                bad += 1
                continue
            rows.append({c: (r[c] or "").strip() for c in COLUMNS})
    return rows, bad


def aggregate(rows):
    groups = {}
    for r in rows:
        key = (r["model"], r["engine"])
        g = groups.setdefault(key, {
            "ttft": [], "total": [], "peak": [], "util": [], "power": [],
            "n_ok": 0, "n_fail": 0, "n_cold": 0, "n_missing_tegra": 0,
            "jetpack": set(), "quant": set(), "fail_notes": [],
        })
        notes = r["notes"]
        run_idx = r["run_idx"]
        is_cold = (run_idx == "0") or (COLD_NOTES_MARK in notes)
        if is_cold:
            g["n_cold"] += 1
            continue
        g["jetpack"].add(r["jetpack_ver"] or "unknown")
        g["quant"].add(r["quant"] or "?")
        ttft = fnum(r["ttft_ms"])
        total = fnum(r["total_infer_ms"])
        peak = fnum(r["peak_mem_mb"])
        util = fnum(r["gpu_util_pct"])
        power = fnum(r["power_w"])
        if peak is not None:
            g["peak"].append(peak)
        else:
            g["n_missing_tegra"] += 1
        if util is not None:
            g["util"].append(util)
        if power is not None:
            g["power"].append(power)
        if ttft is not None and total is not None:
            g["ttft"].append(ttft)
            g["total"].append(total)
            g["n_ok"] += 1
        else:
            g["n_fail"] += 1
            if notes:
                g["fail_notes"].append(notes[:80])
    return groups


def verdict_for(g, latency_key):
    p95 = percentile(sorted(g[latency_key]), 0.95)
    peak_max = max(g["peak"]) if g["peak"] else None
    if p95 is None:
        return None, p95, peak_max  # 数据不足
    reasons = []
    if p95 > THRESH_P95_MS:
        reasons.append("P95 %.1fms > %.0fms" % (p95, THRESH_P95_MS))
    if peak_max is None:
        reasons.append("无内存采样（tegrastats 缺失）")
    elif peak_max > THRESH_PEAK_MEM_MB:
        reasons.append("峰值内存 %.0fMB > %.0fMB" % (peak_max, THRESH_PEAK_MEM_MB))
    if reasons:
        return ("未过线", p95, peak_max), p95, peak_max
    return ("过线", p95, peak_max), p95, peak_max


def build_summary(rows, bad_rows, groups, latency_key, input_path):
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = []
    ap = lines.append
    ap("# W1 VLM 基准裁决报告")
    ap("")
    ap("> **警示：本基准脚本包未在 Orin 目标硬件上实测过**，首跑需人工盯版；")
    ap("> 本报告结论完全依赖 results.csv 的数据质量（cold 行剔除、tegrastats 采样正常）。")
    ap("")
    ap("- 生成时间：%s" % now)
    ap("- 输入文件：`%s`" % input_path)
    ap("- 数据行：共 %d 行（可解析 %d 行，坏行 %d 行）" % (len(rows) + bad_rows, len(rows), bad_rows))
    n_cold = sum(g["n_cold"] for g in groups.values())
    ap("- 其中冷启动丢弃行（run_idx=0）：%d" % n_cold)
    ap("- 裁决口径：延迟取 **%s** 的 P95（--latency %s）；"
       "过线 = P95 <= %.0f ms 且 峰值内存 <= %.0f MB（6GB）"
       % ("TTFT" if latency_key == "ttft" else "总推理时长", latency_key,
          THRESH_P95_MS, THRESH_PEAK_MEM_MB))
    ap("- 双引擎全过线 -> 选维护成本低者（MLC）；单引擎过线 -> 选过线者；"
       "全部未过线 -> 建议降 1B 档。")
    ap("")
    ap("## 聚合表（按 model × engine）")
    ap("")
    ap("| model | engine | runs(ok/fail) | %s P50 | %s P95 | total P50 | total P95"
       " | peakMem(max) MB | power(max) W | GPU util(max)%% | 判定 |"
       % ("TTFT", "TTFT"))
    ap("|---|---|---|---|---|---|---|---|---|---|---|")
    verdicts = {}
    for (model, engine) in sorted(groups):
        g = groups[(model, engine)]
        v, p95, peak_max = verdict_for(g, latency_key)
        verdicts[(model, engine)] = v
        p50 = percentile(sorted(g[latency_key]), 0.50)
        tp50 = percentile(sorted(g["total"]), 0.50)
        tp95 = percentile(sorted(g["total"]), 0.95)
        verdict_cell = v[0] if v else "数据不足"
        ap("| %s | %s | %d/%d | %s | %s | %s | %s | %s | %s | %s | **%s** |" % (
            model, engine, g["n_ok"], g["n_fail"],
            fmt(p50), fmt(p95), fmt(tp50), fmt(tp95),
            fmt(peak_max, 0),
            fmt(max(g["power"]) if g["power"] else None),
            fmt(max(g["util"]) if g["util"] else None, 0),
            verdict_cell))
    ap("")

    ap("## 逐模型推荐")
    ap("")
    model_verdicts = {}
    for model in sorted({m for (m, _) in groups}):
        eng_v = {e: verdicts.get((model, e)) for (_, e) in groups if (model, e) in verdicts}
        passed = [e for e, v in eng_v.items() if v and v[0] == "过线"]
        if len(passed) == 2:
            rec = "双引擎过线 -> **选 MLC-LLM（维护成本低）**"
        elif len(passed) == 1:
            rec = "单引擎（%s）过线 -> **选 %s**" % (passed[0], passed[0])
        else:
            rec = "全未过线/数据不足 -> **建议降 1B 档**"
        model_verdicts[model] = (passed, rec)
        ap("- `%s`：%s（%s）" % (
            model, rec,
            "；".join("%s=%s" % (e, (eng_v[e][0] if eng_v[e] else "数据不足"))
                      for e in sorted(eng_v))))
    ap("")

    ap("## 总裁决")
    ap("")
    all_combos = list(verdicts.items())
    all_pass = bool(all_combos) and all(v and v[0] == "过线" for _, v in all_combos)
    any_pass = [k for k, v in all_combos if v and v[0] == "过线"]
    if all_pass and len({m for (m, _) in groups}) == 3 and len({e for (_, e) in groups}) == 2:
        ap("**全部 6 个 (model, engine) 组合过线 -> 全线选 MLC-LLM（维护成本低）。**")
    elif any_pass:
        ap("**过线组合：%s**。按上表逐模型推荐执行。" % ("、".join("%s × %s" % k for k in any_pass)))
    else:
        ap("**无任何组合过线 -> 建议整体降 1B 档（如 Qwen2-VL-1.5B / InternVL2-1B / SmolVLM2-500M）重测。**")
    ap("")

    ap("## 数据质量提示")
    ap("")
    hinted = False
    for (model, engine), g in sorted(groups.items()):
        if g["n_missing_tegra"]:
            ap("- `%s × %s`：有 %d 行缺 tegrastats 采样（peak_mem/gpu_util/power 空）——"
               "Jetson 上请确认 tegrastats 可用（无 nvidia-smi，勿换工具）。" % (model, engine, g["n_missing_tegra"]))
            hinted = True
        if g["n_fail"]:
            ap("- `%s × %s`：%d 次推理失败，示例 notes：%s"
               % (model, engine, g["n_fail"], "；".join(g["fail_notes"][:3]) or "-"))
            hinted = True
        if not g["ttft"]:
            ap("- `%s × %s`：无任何成功延迟样本，聚合值不可信。" % (model, engine))
            hinted = True
    if not hinted:
        ap("- 无明显数据质量问题。")
    ap("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="W1 基准裁决：results.csv -> summary.md")
    ap.add_argument("--input", "--results", dest="input", default=None,
                    help="results.csv 路径（默认：脚本目录下 results.csv；也可直接传位置参数）")
    ap.add_argument("--out", default=None,
                    help="summary.md 输出路径（默认：与输入同目录 summary.md）")
    ap.add_argument("--latency", choices=["ttft", "total"], default="ttft",
                    help="过线判定使用的延迟口径（默认 ttft）")
    ap.add_argument("positional", nargs="?", default=None, help=argparse.SUPPRESS)
    args = ap.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    input_path = args.input or args.positional or os.path.join(script_dir, "results.csv")
    if not os.path.isfile(input_path):
        print("ERROR: 找不到输入文件 %s（先运行 run_benchmark.sh 生成）" % input_path, file=sys.stderr)
        return 2
    out_path = args.out or os.path.join(os.path.dirname(os.path.abspath(input_path)), "summary.md")

    rows, bad_rows = load_rows(input_path)
    groups = aggregate(rows)
    if not groups:
        print("ERROR: %s 中没有任何可统计数据行" % input_path, file=sys.stderr)
        return 1
    summary = build_summary(rows, bad_rows, groups, args.latency, input_path)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(summary)
    print("已生成 %s" % out_path)
    for (model, engine), g in sorted(groups.items()):
        v, _, _ = verdict_for(g, args.latency)
        print("  %s × %s -> %s" % (model, engine, (v[0] if v else "数据不足")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
