#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""W1 基准：生成 10 张占位桌面截图 + prompts.txt（10 条固定中文指令）。

注意：
- 生成的图片是【合成占位图】，用于打通基准管线；正式的桌面抓取图集
  由人类替换，只需保持文件名（desktop_00.png .. desktop_09.png）与
  尺寸一致即可，prompts.txt 不变。
- 若环境装有 Pillow 则绘制含文字标签的桌面 mockup；否则退化为纯
  标准库 PNG 写出器（仅几何图形，无文字）。
- 本脚本只依赖 Python 标准库（Pillow 可选）。

用法：
  python3 gen_fixtures.py [--out-dir fixtures] [--size 1280x720]
"""
import argparse
import os
import random
import re
import struct
import sys
import zlib

DEFAULT_SIZE = (1280, 720)

# ---------------------------------------------------------------- 固定指令集
PROMPTS = [
    "描述这张桌面截图中打开了哪些窗口。",
    "最上层窗口的标题是什么？它大概位于屏幕什么位置？",
    "屏幕底部任务栏上有哪些图标？请逐一列出。",
    "截图中是否出现了文本编辑器？如果有，请说明依据。",
    "请读出截图中面积最大的一块文字内容。",
    "这张桌面的主色调是什么？背景壁纸有什么特征？",
    "画面里是否存在弹窗或对话框？如果有，内容大意是什么？",
    "用一句话概括这张桌面截图的主要使用场景。",
    "截图中是否有媒体播放器或视频窗口？它在播放什么？",
    "列出画面中所有你能识别的按钮、菜单或图标文字。",
]

WINDOW_TITLES = ["Terminal", "Browser", "Editor", "Files", "Player", "Settings"]
PALETTES = [
    ((36, 41, 51), (60, 76, 110), (70, 130, 180)),    # 蓝灰
    ((40, 44, 52), (84, 110, 122), (120, 144, 156)),  # 青灰
    ((48, 40, 44), (110, 70, 90), (170, 110, 130)),   # 暖紫
    ((30, 42, 34), (62, 96, 72), (110, 160, 120)),    # 墨绿
    ((44, 42, 36), (100, 90, 60), (160, 140, 90)),    # 土黄
]


# ---------------------------------------------------------------- 布局规划
def build_layout(idx, w, h):
    """用确定性随机（seed=idx）规划一张桌面 mockup 的元素。"""
    rnd = random.Random(1000 + idx)
    bg_top, bg_bottom, accent = PALETTES[rnd.randrange(len(PALETTES))]
    windows = []
    n_win = rnd.randint(2, 4)
    titles = rnd.sample(WINDOW_TITLES, n_win)
    for k in range(n_win):
        ww = rnd.randint(w // 3, w // 2)
        wh = rnd.randint(h // 3, int(h * 0.6))
        x = rnd.randint(0, max(1, w - ww - 10))
        y = rnd.randint(0, max(1, h - wh - 60))  # 底部留给任务栏
        windows.append({
            "title": titles[k],
            "rect": (x, y, x + ww, y + wh),
            "titlebar_h": 28,
            "border": tuple(min(255, c + 40) for c in accent),
            "fill": tuple(min(255, c + 14) for c in bg_top),
            "line_color": tuple(min(255, c + 26) for c in bg_bottom),
            "n_lines": rnd.randint(6, 14),
            "z_top": (k == n_win - 1),  # 最后画 = 最上层
        })
    taskbar_h = 44
    icons = [rnd.randrange(1, 240) for _ in range(8)]  # 伪图标宽度/色偏
    return {
        "idx": idx, "w": w, "h": h,
        "bg_top": bg_top, "bg_bottom": bg_bottom, "accent": accent,
        "windows": windows, "taskbar_h": taskbar_h, "icons": icons,
        "clock": "12:%02d" % (10 + idx),
    }


# ---------------------------------------------------------------- 标准库 PNG
def _png_chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, w, h, buf):
    """buf: list of bytearray(3*w)，无滤波字节。"""
    raw = b"".join(b"\x00" + bytes(row) for row in buf)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8bit truecolor
    png = (b"\x89PNG\r\n\x1a\n"
           + _png_chunk(b"IHDR", ihdr)
           + _png_chunk(b"IDAT", zlib.compress(raw, 6))
           + _png_chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def _lerp(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def fill_rect(buf, x0, y0, x1, y1, color, w, h):
    x0, x1 = max(0, x0), min(w, x1)
    y0, y1 = max(0, y0), min(h, y1)
    rgb = bytes(color)
    for y in range(y0, y1):
        row = buf[y]
        for x in range(x0, x1):
            row[3 * x:3 * x + 3] = rgb


def render_stdlib(layout):
    w, h = layout["w"], layout["h"]
    buf = []
    for y in range(h):
        row = bytearray()
        row += bytes(_lerp(layout["bg_top"], layout["bg_bottom"], y / max(1, h - 1))) * w
        buf.append(row)
    # 窗口
    for win in layout["windows"]:
        x0, y0, x1, y1 = win["rect"]
        fill_rect(buf, x0, y0, x1, y1, win["fill"], w, h)
        # 标题栏
        fill_rect(buf, x0, y0, x1, y0 + win["titlebar_h"], win["border"], w, h)
        # 边框
        fill_rect(buf, x0, y0, x1, y0 + 2, win["border"], w, h)
        fill_rect(buf, x0, y1 - 2, x1, y1, win["border"], w, h)
        fill_rect(buf, x0, y0, x0 + 2, y1, win["border"], w, h)
        fill_rect(buf, x1 - 2, y0, x1, y1, win["border"], w, h)
        # 标题栏三个圆点（关闭/最小化/最大化占位）
        for i in range(3):
            cx = x1 - 12 - i * 14
            fill_rect(buf, cx, y0 + 9, cx + 8, y0 + 17, (230, 230, 230), w, h)
        # 正文行
        ly = y0 + win["titlebar_h"] + 10
        for _ in range(win["n_lines"]):
            if ly + 6 >= y1 - 4:
                break
            fill_rect(buf, x0 + 12, ly, x1 - 12, ly + 6, win["line_color"], w, h)
            ly += 14
    # 任务栏
    tb_y = h - layout["taskbar_h"]
    fill_rect(buf, 0, tb_y, w, h, layout["accent"], w, h)
    ix = 12
    for off in layout["icons"]:
        c = tuple(min(255, layout["accent"][i] + 60 + off % 60) for i in range(3))
        fill_rect(buf, ix, tb_y + 8, ix + 30, tb_y + layout["taskbar_h"] - 8, c, w, h)
        ix += 44
    return buf


# ---------------------------------------------------------------- Pillow 路径
def render_pillow(layout, path):
    from PIL import Image, ImageDraw
    w, h = layout["w"], layout["h"]
    img = Image.new("RGB", (w, h), layout["bg_top"])
    dr = ImageDraw.Draw(img)
    for y in range(h):  # 渐变背景
        dr.line([(0, y), (w, y)], fill=_lerp(layout["bg_top"], layout["bg_bottom"], y / max(1, h - 1)))
    for win in layout["windows"]:
        x0, y0, x1, y1 = win["rect"]
        tb = y0 + win["titlebar_h"]
        dr.rectangle([x0, y0, x1, y1], fill=win["fill"], outline=win["border"], width=2)
        dr.rectangle([x0, y0, x1, tb], fill=win["border"])
        dr.text((x0 + 8, y0 + 7), win["title"], fill=(255, 255, 255))  # ASCII 占位标签
        for i in range(3):
            cx = x1 - 60 + i * 16
            dr.rectangle([cx, y0 + 9, cx + 8, y0 + 17], fill=(230, 230, 230))
        ly = tb + 10
        for _ in range(win["n_lines"]):
            if ly + 6 >= y1 - 4:
                break
            dr.rectangle([x0 + 12, ly, x1 - 12, ly + 6], fill=win["line_color"])
            ly += 14
    tb_y = h - layout["taskbar_h"]
    dr.rectangle([0, tb_y, w, h], fill=layout["accent"])
    ix = 12
    for _ in layout["icons"]:
        dr.rectangle([ix, tb_y + 8, ix + 30, tb_y + layout["taskbar_h"] - 8],
                     outline=(240, 240, 240), width=2)
        ix += 44
    dr.text((w - 70, tb_y + 13), layout["clock"], fill=(255, 255, 255))
    img.save(path, "PNG")
    return img


# ---------------------------------------------------------------- 主流程
def parse_size(s):
    m = re.fullmatch(r"(\d{2,5})x(\d{2,5})", s.strip().lower())
    if not m:
        raise argparse.ArgumentTypeError("尺寸格式应为 WIDTHxHEIGHT，例如 1280x720")
    w, h = int(m.group(1)), int(m.group(2))
    if not (160 <= w <= 4096 and 120 <= h <= 4096):
        raise argparse.ArgumentTypeError("尺寸需在 160..4096 范围内")
    return (w, h)


def main():
    ap = argparse.ArgumentParser(description="生成 W1 基准占位图集与固定指令集")
    script_dir = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--out-dir", default=os.path.join(script_dir, "fixtures"),
                    help="输出目录（默认 <脚本目录>/fixtures）")
    ap.add_argument("--size", type=parse_size, default=DEFAULT_SIZE,
                    help="图片尺寸 WIDTHxHEIGHT（默认 1280x720）")
    args = ap.parse_args()

    w, h = args.size
    os.makedirs(args.out_dir, exist_ok=True)

    try:
        from PIL import Image  # noqa: F401
        backend = "pillow"
    except ImportError:
        backend = "stdlib"

    # prompts.txt（固定 10 条，覆盖写入）
    prompts_path = os.path.join(args.out_dir, "prompts.txt")
    assert len(PROMPTS) == 10, "固定指令集必须为 10 条"
    with open(prompts_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(PROMPTS) + "\n")

    names = []
    for i in range(10):
        layout = build_layout(i, w, h)
        path = os.path.join(args.out_dir, "desktop_%02d.png" % i)
        if backend == "pillow":
            render_pillow(layout, path)
        else:
            write_png(path, w, h, render_stdlib(layout))
        names.append(os.path.basename(path))

    print("后端        : %s%s" % (backend, "" if backend == "pillow" else "（未装 Pillow，退化为无文字几何占位图）"))
    print("尺寸        : %dx%d" % (w, h))
    print("图片        : %d 张 -> %s" % (len(names), args.out_dir))
    print("指令        : %d 条 -> %s" % (len(PROMPTS), prompts_path))
    print()
    print("【重要】以上为合成占位图，仅用于打通基准管线；")
    print("正式桌面抓取图集由人类替换：保持文件名 desktop_00.png..desktop_09.png")
    print("与尺寸一致即可，prompts.txt 保持不变。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
