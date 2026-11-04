"""Draw the app icons (rope arc + handles on orange) as PNGs.  python web/make_icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "icons"
ORANGE = (239, 90, 36)
WHITE = (255, 255, 255)


def draw(size: int, maskable: bool) -> Image.Image:
    s = size * 4  # supersample, then shrink for smooth edges
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskable:  # full bleed; Android crops it to its own shape
        d.rectangle([0, 0, s, s], fill=ORANGE)
        scale = 0.62  # keep the artwork inside the safe zone
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.23), fill=ORANGE)
        scale = 0.78
    # artwork on a 24-unit grid: two handles held up, the rope hanging in a loop below them
    u = s * scale / 24
    o = (s - 24 * u) / 2
    P = lambda x, y: (o + x * u, o + y * u)  # noqa: E731
    w = u * 1.55  # rope thickness
    # rope: a smooth catenary-like curve from one handle tip to the other
    pts = []
    for i in range(121):
        k = i / 120
        x = 6.5 + 11 * k
        y = 9.6 + 12.6 * (1 - (2 * k - 1) ** 2) ** 0.8  # deep, rounded loop
        pts.append(P(x, y))
    for q in pts:  # round-capped thick line
        d.ellipse([q[0] - w / 2, q[1] - w / 2, q[0] + w / 2, q[1] + w / 2], fill=WHITE)
    # handles: capsules, tilted slightly outward
    for x, tilt in ((6.5, -1.1), (17.5, 1.1)):
        top, bot = P(x + tilt, 2.6), P(x, 10.2)
        hw = u * 1.55
        d.line([top, bot], fill=WHITE, width=int(hw * 2))
        for q in (top, bot):
            d.ellipse([q[0] - hw, q[1] - hw, q[0] + hw, q[1] + hw], fill=WHITE)
    return im.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for size in (192, 512):
        draw(size, False).save(OUT / f"icon-{size}.png")
        draw(size, True).save(OUT / f"maskable-{size}.png")
    apple = draw(180, True).convert("RGB")  # iOS rounds the corners itself; no transparency
    apple.save(OUT / "apple-touch-icon.png")
    draw(32, False).save(OUT / "favicon-32.png")
    print("wrote", sorted(p.name for p in OUT.iterdir()))
