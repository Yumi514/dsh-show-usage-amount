"""Regenerate src/icon-glyph.svg from src/icon.png.

Run from the plugin root:

    python src/trace-icon.py

Pipeline, and why each step is there:

1. Threshold the luminance into an ink mask (the mark is one flat colour on a
   white tile, so this is lossless).
2. Upsample the LUMINANCE and re-threshold, so the rim is sampled sub-pixel
   instead of snapping to the source's pixel grid.
3. Contour with marching squares.
4. Circular moving-average the dense contour. A straight run stays straight
   under a moving average, while pixel staircase noise averages away — this is
   what turns the jagged diagonal of the "A" into one clean edge.
5. Douglas-Peucker at a tolerance measured in ORIGINAL pixels.

All contours go into one path with fill-rule="evenodd", so the counters (the U
bowl, the A triangle) fall out without hole bookkeeping.

After regenerating, copy the new path into GLYPH_PATH in lib/client.js —
`node test-client.mjs` fails loudly until the two match.
"""

import math
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "icon.png"
OUT = ROOT / "src" / "icon-glyph.svg"

UP = 4             # mask upsample factor
SMOOTH_PASSES = 6  # circular moving-average passes over the dense contour
SMOOTH_WINDOW = 9  # odd; in upsampled pixels
EPS_ORIG = 0.30    # Douglas-Peucker tolerance, in ORIGINAL pixels
PAD_RATIO = 0.055  # breathing room around the glyph, as a fraction of its long side

im = Image.open(SRC).convert("RGB")
w, h = im.size
rgb = np.asarray(im).astype(np.float32)
lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
mask = lum < 155.0

ys, xs = np.nonzero(mask)
x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
gw, gh = x1 - x0 + 1, y1 - y0 + 1
print(f"glyph bbox x {x0}..{x1} y {y0}..{y1} ({gw}x{gh}px)")

ink = Counter()
for y, x in zip(ys, xs):
    ink[tuple(int(v) for v in rgb[y, x])] += 1
ink_rgb = ink.most_common(1)[0][0]
print("ink colour: #%02X%02X%02X" % ink_rgb)

big = Image.fromarray(lum.astype(np.uint8)).resize((w * UP, h * UP), Image.BICUBIC)
big_mask = np.asarray(big).astype(np.float32) < 155.0
m = 2 * UP
sub = big_mask[y0 * UP - m : (y1 + 1) * UP + m, x0 * UP - m : (x1 + 1) * UP + m]
sub = np.pad(sub, 1, constant_values=False)


def marching_squares(binary):
    f = np.pad(binary, 1, constant_values=False)
    gh_, gw_ = f.shape
    table = {
        1: [("l", "b")], 2: [("b", "r")], 3: [("l", "r")], 4: [("t", "r")],
        5: [("t", "l"), ("b", "r")], 6: [("t", "b")], 7: [("t", "l")],
        8: [("t", "l")], 9: [("t", "b")], 10: [("t", "r"), ("b", "l")],
        11: [("t", "r")], 12: [("l", "r")], 13: [("b", "r")], 14: [("l", "b")],
    }
    segs = []
    for r in range(gh_ - 1):
        for c in range(gw_ - 1):
            idx = (f[r, c] << 3) | (f[r, c + 1] << 2) | (f[r + 1, c + 1] << 1) | f[r + 1, c]
            if idx in (0, 15):
                continue
            pts = {"t": (c + 0.5, float(r)), "r": (float(c + 1), r + 0.5),
                   "b": (c + 0.5, float(r + 1)), "l": (float(c), r + 0.5)}
            for a, b in table[idx]:
                segs.append((pts[a], pts[b]))

    adj = {}
    for p, q in segs:
        adj.setdefault(p, []).append(q)
        adj.setdefault(q, []).append(p)

    used, loops = set(), []
    for start in list(adj):
        for nxt in adj[start]:
            if (start, nxt) in used:
                continue
            loop = [start]
            prev, cur = start, nxt
            used.add((start, nxt))
            used.add((nxt, start))
            while cur != start:
                loop.append(cur)
                options = [p for p in adj[cur] if p != prev and (cur, p) not in used]
                if not options:
                    break
                step = options[0]
                used.add((cur, step))
                used.add((step, cur))
                prev, cur = cur, step
            if len(loop) > 3:
                loops.append(loop)
    return loops


def poly_area(loop):
    s = 0.0
    for i in range(len(loop)):
        ax, ay = loop[i]
        bx, by = loop[(i + 1) % len(loop)]
        s += ax * by - bx * ay
    return abs(s) / 2.0


def smooth_closed(loop, window, passes):
    """Circular moving average: straight runs stay straight, staircase noise dies."""
    pts = np.array(loop, dtype=np.float64)
    if len(pts) < window * 2:
        return loop
    half = window // 2
    for _ in range(passes):
        n = len(pts)
        padded = np.vstack([pts[-half:], pts, pts[:half]])
        kernel = np.ones(window) / window
        pts = np.column_stack([
            np.convolve(padded[:, 0], kernel, mode="valid"),
            np.convolve(padded[:, 1], kernel, mode="valid"),
        ])
        assert len(pts) == n
    return [tuple(p) for p in pts]


def rdp(points, eps):
    if len(points) < 3:
        return points
    (ax, ay), (bx, by) = points[0], points[-1]
    dx, dy = bx - ax, by - ay
    norm = math.hypot(dx, dy)
    best_i, best_d = 0, -1.0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        d = math.hypot(px - ax, py - ay) if norm == 0 else abs(dy * px - dx * py + bx * ay - by * ax) / norm
        if d > best_d:
            best_i, best_d = i, d
    if best_d <= eps:
        return [points[0], points[-1]]
    return rdp(points[: best_i + 1], eps)[:-1] + rdp(points[best_i:], eps)


def simplify_closed(loop, eps):
    if len(loop) < 6:
        return loop
    ax, ay = loop[0]
    far = max(range(len(loop)), key=lambda i: (loop[i][0] - ax) ** 2 + (loop[i][1] - ay) ** 2)
    return rdp(loop[: far + 1], eps)[:-1] + rdp(loop[far:] + [loop[0]], eps)[:-1]


loops = [l for l in marching_squares(sub) if poly_area(l) >= 4.0 * UP * UP]
print("contours:", len(loops), "areas(px^2):", [round(poly_area(l) / UP / UP, 1) for l in loops])

smoothed = [smooth_closed(l, SMOOTH_WINDOW, SMOOTH_PASSES) for l in loops]
simplified = [simplify_closed(l, EPS_ORIG * UP) for l in smoothed]
print("points:", [len(l) for l in loops], "->", [len(l) for l in simplified])

# Contour space -> glyph space. `sub` is `big_mask` cropped at (y0*UP - m) then
# padded by 1, and marching_squares pads by 1 again, so contour coordinate p
# maps to original-image pixel (p - 2 - m) / UP relative to the glyph's corner.
scale = 1000.0 / max(gw, gh)


def to_glyph(px, py):
    return ((px - 2 - m) / UP) * scale, ((py - 2 - m) / UP) * scale


def fmt(v):
    return ("%.2f" % v).rstrip("0").rstrip(".")


# Normalize into a padded box: contour points can land a hair outside the mask
# bbox (half-pixel marching-squares midpoints), and a nav glyph needs breathing
# room rather than touching the edge of its 16px cell.
all_pts = [to_glyph(px, py) for loop in simplified for px, py in loop]
min_x = min(p[0] for p in all_pts)
max_x = max(p[0] for p in all_pts)
min_y = min(p[1] for p in all_pts)
max_y = max(p[1] for p in all_pts)
content_w, content_h = max_x - min_x, max_y - min_y
pad = PAD_RATIO * max(content_w, content_h)

parts = []
for loop in simplified:
    pts = [to_glyph(px, py) for px, py in loop]
    if len(pts) > 1 and math.dist(pts[0], pts[-1]) < 1e-9:
        pts = pts[:-1]
    pts = [(x - min_x + pad, y - min_y + pad) for x, y in pts]
    start = min(range(len(pts)), key=lambda i: (round(pts[i][1], 2), round(pts[i][0], 2)))
    pts = pts[start:] + pts[:start]
    d = "M" + " ".join(f"{fmt(x)},{fmt(y)}" for x, y in pts[:1])
    d += "L" + " ".join(f"{fmt(x)},{fmt(y)}" for x, y in pts[1:])
    parts.append(d + "Z")

path = "".join(parts)
vw = content_w + 2 * pad
vh = content_h + 2 * pad
svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(vw)} {fmt(vh)}" '
    f'fill="currentColor" fill-rule="evenodd" aria-hidden="true">'
    f'<path d="{path}"/></svg>'
)
OUT.write_text(svg, encoding="utf-8")

print(f"viewBox 0 0 {fmt(vw)} {fmt(vh)}")
print("subpaths:", len(parts), "path chars:", len(path), "svg bytes:", len(svg))
print("OUT:", OUT)
