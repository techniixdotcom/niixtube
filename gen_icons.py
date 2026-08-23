from PIL import Image, ImageDraw

SIZES = [128, 48, 32, 16]
BG = (15, 15, 15, 255)
RED = (204, 0, 0, 255)
WHITE = (255, 255, 255, 255)


def make_icon(size):
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = int(s * 0.22)
    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    # Play triangle, slightly left of center to leave room for the queue dot
    cx, cy = s * 0.46, s * 0.52
    tri_h = s * 0.34
    tri_w = s * 0.30
    points = [
        (cx - tri_w / 2, cy - tri_h / 2),
        (cx - tri_w / 2, cy + tri_h / 2),
        (cx + tri_w / 2, cy),
    ]
    draw.polygon(points, fill=WHITE)

    # Queue dot badge, top-right, representing the enqueue feature
    if size >= 32:
        dot_r = s * 0.14
        dot_cx, dot_cy = s * 0.80, s * 0.22
        draw.ellipse(
            [dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r],
            fill=RED,
            outline=BG,
            width=int(s * 0.02),
        )

    img = img.resize((size, size), Image.LANCZOS)
    return img


for size in SIZES:
    icon = make_icon(size)
    icon.save(f"src/icons/icon-{size}.png")
    print(f"wrote icon-{size}.png")
