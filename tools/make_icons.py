"""生成扩展图标：圆角渐变底 + 白色播放三角 + 底部进度条。"""
from PIL import Image, ImageDraw

OUT = r"D:\DSH\zhihuishu-auto\icons"
SS = 8  # 超采样倍率

# 底色渐变：顶部深 -> 底部亮
TOP = (34, 84, 170)
BOT = (79, 156, 249)


def gradient(size):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        g.putpixel((0, y), tuple(int(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3)))
    return g.resize((size, size))


def make(size):
    s = size * SS
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # 圆角矩形遮罩
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, s - 1, s - 1], radius=int(s * 0.24), fill=255
    )
    canvas.paste(gradient(s), (0, 0), mask)

    d = ImageDraw.Draw(canvas)
    white = (255, 255, 255, 255)

    # 播放三角（略微上移，给进度条让位）
    cx, cy = s * 0.50, s * 0.455
    r = s * 0.235
    d.polygon(
        [
            (cx - r * 0.62, cy - r),
            (cx - r * 0.62, cy + r),
            (cx + r * 1.00, cy),
        ],
        fill=white,
    )

    # 底部进度条：已播 62%
    if size >= 32:
        bar_h = max(int(s * 0.055), 1)
        bx0, bx1 = int(s * 0.22), int(s * 0.78)
        by0 = int(s * 0.755)
        by1 = by0 + bar_h
        d.rounded_rectangle([bx0, by0, bx1, by1], radius=bar_h // 2, fill=(255, 255, 255, 70))
        mid = int(bx0 + (bx1 - bx0) * 0.62)
        d.rounded_rectangle([bx0, by0, mid, by1], radius=bar_h // 2, fill=white)

    return canvas.resize((size, size), Image.LANCZOS)


for sz in (16, 32, 48, 128):
    img = make(sz)
    path = f"{OUT}\\icon{sz}.png"
    img.save(path, "PNG")
    print(f"wrote {path}  {img.size[0]}x{img.size[1]}")
