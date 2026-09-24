#!/usr/bin/env python3
"""
Generate Darjeeling's surface textures as SVG, plus a CSS fragment of
URL-encoded data URIs.

Why procedural: a crackle network hand-typed as path data is unreadable and
unmaintainable, and a PNG cannot recolour itself per theme. These are seeded,
so the output is identical every run -- regenerate with `python3 generate.py`.

  craze      crackle in a cooling glaze, and in a leaf as it cures
  ridgeline  terraces stepping up a hillside, seen through haze
  grain      the tooth of unbleached paper
  fray       a leaf edge torn along the vein, for dividers
"""

import math
import random
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).parent


def craze(size=260, seeds=52, seed=11) -> str:
    """
    Crackle in a cooling glaze.

    An earlier version walked random paths, which produced scribbles. Real
    crazing is a *network*: longish, nearly straight lines that terminate on
    each other at junctions and enclose irregular polygons. So this scatters
    nucleation points and joins each to its nearest neighbours — a proximity
    graph — with only slight bowing along each edge.

    Kept sparse and thin on purpose; at the opacity it is used the pattern
    should be felt rather than seen.
    """
    rng = random.Random(seed)
    pts = [(rng.uniform(0, size), rng.uniform(0, size)) for _ in range(seeds)]

    def dist(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1])

    edges = set()
    for i, a in enumerate(pts):
        ranked = sorted(
            ((dist(a, b), j) for j, b in enumerate(pts) if j != i), key=lambda t: t[0]
        )
        # Two or three neighbours: enough to enclose cells, not enough to mesh.
        for _, j in ranked[: rng.choice([2, 2, 3])]:
            # Skip the long chords that would cross the whole tile.
            if dist(a, pts[j]) < size * 0.26:
                edges.add((min(i, j), max(i, j)))

    body = []
    for i, j in sorted(edges):
        (x1, y1), (x2, y2) = pts[i], pts[j]
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        # A craze line is not a ruler line; bow it a little, perpendicular.
        nx, ny = -(y2 - y1), (x2 - x1)
        length = math.hypot(nx, ny) or 1
        bow = rng.uniform(-0.055, 0.055) * length
        cx, cy = mx + nx / length * bow, my + ny / length * bow
        width = rng.choice([0.45, 0.55, 0.7])
        body.append(
            f'<path d="M {x1:.1f},{y1:.1f} Q {cx:.1f},{cy:.1f} {x2:.1f},{y2:.1f}" '
            f'fill="none" stroke="#000" stroke-width="{width}" '
            f'stroke-linecap="round" opacity="{rng.uniform(0.45, 1.0):.2f}"/>'
        )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}">{"".join(body)}</svg>'
    )


def ridgeline(width=1200, height=260, ranges=5, seed=5) -> str:
    """
    Terraced hills receding into haze.

    Each range sits higher, is flatter, and is paler than the one in front --
    aerial perspective does the depth, not a drop shadow.
    """
    rng = random.Random(seed)
    layers = []

    for i in range(ranges):
        depth = i / max(1, ranges - 1)
        base = height * (0.92 - 0.13 * i)
        amp = (1 - depth) * 38 + 8
        opacity = 0.16 + 0.13 * (1 - depth)

        pts = []
        steps = 26
        phase = rng.uniform(0, math.tau)
        for s in range(steps + 1):
            t = s / steps
            x = t * width
            y = (
                base
                - math.sin(t * math.pi * (1.4 + i * 0.5) + phase) * amp
                - math.sin(t * math.pi * (3.1 + i) + phase * 1.7) * amp * 0.32
            )
            pts.append((x, y))

        d = (
            f"M 0,{height} L "
            + " L ".join(f"{px:.1f},{py:.1f}" for px, py in pts)
            + f" L {width},{height} Z"
        )
        layers.append(f'<path d="{d}" fill="#000" opacity="{opacity:.3f}"/>')

        # A hairline along the lit crest: the silver-hair idea at landscape scale.
        crest = "M " + " L ".join(f"{px:.1f},{py:.1f}" for px, py in pts)
        layers.append(
            f'<path d="{crest}" fill="none" stroke="#000" '
            f'stroke-width="0.9" opacity="{0.20 + 0.16 * (1 - depth):.3f}"/>'
        )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" preserveAspectRatio="none">'
        f'{"".join(layers)}</svg>'
    )


def grain(size=200, seed=2) -> str:
    """Paper tooth. Turbulence is the right tool and costs one filter."""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}">'
        f'<filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.82" '
        f'numOctaves="3" seed="{seed}" stitchTiles="stitch"/>'
        f'<feColorMatrix type="saturate" values="0"/></filter>'
        f'<rect width="{size}" height="{size}" filter="url(#g)"/></svg>'
    )


def fray(width=400, height=7, seed=17) -> str:
    """
    A divider torn rather than ruled.

    Thickness varies and the line breaks: a tea leaf tears along the vein and
    leaves a ragged edge, so a divider here is not a 1px rule.
    """
    rng = random.Random(seed)
    segments = []
    x = 0.0
    while x < width:
        run = rng.uniform(14, 54)
        gap = rng.uniform(0, 7) if rng.random() < 0.3 else 0
        y = height / 2 + rng.uniform(-1.1, 1.1)
        y2 = height / 2 + rng.uniform(-1.1, 1.1)
        thick = rng.choice([0.6, 0.8, 1.0, 1.3])
        segments.append(
            f'<path d="M {x:.1f},{y:.1f} Q {x + run / 2:.1f},'
            f'{(y + y2) / 2 + rng.uniform(-0.9, 0.9):.1f} {x + run:.1f},{y2:.1f}" '
            f'fill="none" stroke="#000" stroke-width="{thick}" '
            f'stroke-linecap="round" opacity="{rng.uniform(0.5, 1.0):.2f}"/>'
        )
        x += run + gap
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" preserveAspectRatio="none">'
        f'{"".join(segments)}</svg>'
    )


def data_uri(svg: str) -> str:
    """
    Encode for CSS url().

    Consumed via `mask-image`, not `background-image`. An SVG referenced as an
    image is a separate document and cannot inherit the page's `color`, so
    `currentColor` silently resolves to black and the texture disappears on a
    dark surface. As a mask only alpha matters, and `background-color` does the
    recolouring -- one texture, any surface.
    """
    return "url(\"data:image/svg+xml," + quote(svg, safe="") + "\")"


TEXTURES = {
    "craze": craze(),
    "ridgeline": ridgeline(),
    "grain": grain(),
    "fray": fray(),
}

for name, svg in TEXTURES.items():
    (HERE / f"{name}.svg").write_text(svg)

css = ["/* GENERATED by textures/generate.py — do not hand-edit. */", ".darjeeling-root {"]
for name, svg in TEXTURES.items():
    css.append(f"  --dj-tx-{name}: {data_uri(svg)};")
css.append("}")
(HERE / "textures.css").write_text("\n".join(css) + "\n")

for name, svg in TEXTURES.items():
    print(f"  {name:<10} {len(svg):>6} bytes svg   {len(data_uri(svg)):>6} bytes uri")
