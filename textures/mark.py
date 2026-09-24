#!/usr/bin/env python3
"""
The Darjeeling mark: two leaves and a bud.

That phrase is the plucking standard — the top bud plus the two leaves below
it is what gets picked for a first-flush tea and left on the bush otherwise.
It is the most specific thing the project could be named after, it is
symmetrical enough to read at 16px, and the bud gives a natural place for the
silver-hair highlight.

Two outputs from one geometry:
  mark.svg   monochrome, for a CSS mask in the header
  icon.svg   full colour on an oxidised ground, for the app icon
"""

from pathlib import Path

HERE = Path(__file__).parent


def leaf(cx: float, cy: float, length: float, angle: float, curl: float = 0.22) -> str:
    """
    One lanceolate leaf, drawn as two mirrored quadratic curves from base to
    tip. `angle` is degrees from vertical; positive leans right.
    """
    import math

    rad = math.radians(angle)
    tx = cx + math.sin(rad) * length
    ty = cy - math.cos(rad) * length
    # Perpendicular, for the belly of each side.
    px, py = math.cos(rad), math.sin(rad)
    w = length * curl
    mx, my = (cx + tx) / 2, (cy + ty) / 2
    return (
        f"M {cx:.2f},{cy:.2f} "
        f"Q {mx + px * w:.2f},{my + py * w:.2f} {tx:.2f},{ty:.2f} "
        f"Q {mx - px * w:.2f},{my - py * w:.2f} {cx:.2f},{cy:.2f} Z"
    )


def vein(cx: float, cy: float, length: float, angle: float) -> str:
    import math

    rad = math.radians(angle)
    tx = cx + math.sin(rad) * length * 0.86
    ty = cy - math.cos(rad) * length * 0.86
    return f"M {cx:.2f},{cy:.2f} L {tx:.2f},{ty:.2f}"


# Geometry shared by both outputs, on a 64-unit grid.
BASE_X, BASE_Y = 32.0, 52.0
BUD = leaf(BASE_X, BASE_Y, 27, 0, 0.26)
LEAF_L = leaf(BASE_X, BASE_Y - 4, 25, -52, 0.30)
LEAF_R = leaf(BASE_X, BASE_Y - 4, 25, 52, 0.30)
VEIN_BUD = vein(BASE_X, BASE_Y, 27, 0)


def mark_svg() -> str:
    """Monochrome silhouette for masking. Veins are knocked out of the fill."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
        '<g fill="#000" fill-rule="evenodd">'
        f'<path d="{LEAF_L}"/><path d="{LEAF_R}"/><path d="{BUD}"/>'
        "</g>"
        # Stem, and the bud's midrib cut back in as a hairline.
        f'<path d="M {BASE_X},{BASE_Y} L {BASE_X},57" stroke="#000" stroke-width="3.4" stroke-linecap="round"/>'
        "</svg>"
    )


def icon_svg(size: int = 512, terraces: bool = True) -> str:
    """
    App icon. Oxidised ground, terraces behind, liquor-coloured leaves, and the
    silver hair along the bud's lit edge.
    """
    s = size / 64  # scale factor from the 64-unit grid
    r = 14 * s     # macOS-ish corner radius on a full-bleed tile

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#1F2E22"/>
      <stop offset="0.55" stop-color="#141915"/>
      <stop offset="1" stop-color="#241F16"/>
    </linearGradient>
    <linearGradient id="liquor" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#F4E9D2"/>
      <stop offset="0.38" stop-color="#E6CE92"/>
      <stop offset="0.72" stop-color="#E0822E"/>
      <stop offset="1" stop-color="#A65E28"/>
    </linearGradient>
    <linearGradient id="sideleaf" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#93BE8A"/>
      <stop offset="0.6" stop-color="#6B9C6B"/>
      <stop offset="1" stop-color="#3A5340"/>
    </linearGradient>
    <linearGradient id="hair" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#D8DCCF" stop-opacity="0"/>
      <stop offset="1" stop-color="#F5F8F0" stop-opacity="0.95"/>
    </linearGradient>
    <clipPath id="tile">
      <rect width="{size}" height="{size}" rx="{r:.1f}" ry="{r:.1f}"/>
    </clipPath>
  </defs>

  <g clip-path="url(#tile)">
    <rect width="{size}" height="{size}" fill="url(#ground)"/>

    <!-- Terraces: three ridges receding, paler as they go back. -->
    <g fill="#6B9C6B" opacity="{1 if terraces else 0}">
      <path d="M 0,{0.80 * size:.0f} Q {0.28 * size:.0f},{0.70 * size:.0f} {0.52 * size:.0f},{0.77 * size:.0f}
               Q {0.78 * size:.0f},{0.85 * size:.0f} {size},{0.74 * size:.0f} L {size},{size} L 0,{size} Z"
            opacity="0.10"/>
      <path d="M 0,{0.88 * size:.0f} Q {0.32 * size:.0f},{0.79 * size:.0f} {0.58 * size:.0f},{0.86 * size:.0f}
               Q {0.82 * size:.0f},{0.92 * size:.0f} {size},{0.84 * size:.0f} L {size},{size} L 0,{size} Z"
            opacity="0.14"/>
      <path d="M 0,{0.96 * size:.0f} Q {0.38 * size:.0f},{0.89 * size:.0f} {0.66 * size:.0f},{0.94 * size:.0f}
               Q {0.86 * size:.0f},{0.97 * size:.0f} {size},{0.92 * size:.0f} L {size},{size} L 0,{size} Z"
            opacity="0.18"/>
    </g>

    <g transform="translate({size / 2:.1f} {size * 0.52:.1f}) scale({s * 1.02:.4f}) translate(-32 -32)">
      <!-- Side leaves sit behind the bud. -->
      <path d="{LEAF_L}" fill="url(#sideleaf)"/>
      <path d="{LEAF_R}" fill="url(#sideleaf)"/>
      <!-- The bud: brewed-liquor gradient, cream at the tip. -->
      <path d="{BUD}" fill="url(#liquor)"/>
      <!-- Silver hair down the lit edge of the bud. -->
      <path d="{BUD}" fill="none" stroke="url(#hair)" stroke-width="1.4"/>
      <!-- Midrib, knocked back so it reads as a fold not a line. -->
      <path d="{VEIN_BUD}" stroke="#7A4A18" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>
      <path d="M 32,52 L 32,57" stroke="#8A5A22" stroke-width="3.4" stroke-linecap="round"/>
    </g>
  </g>
</svg>"""


(HERE / "mark.svg").write_text(mark_svg())
(HERE / "icon.svg").write_text(icon_svg(512))
# Small sizes drop the terraces: at 16-32px they are sub-pixel mud.
(HERE / "icon-small.svg").write_text(icon_svg(64, terraces=False))

# Obsidian's addIcon() takes the *inner* SVG and wraps it in viewBox 0 0 100 100,
# so the 64-unit geometry has to be scaled up for the ribbon and tab icon.
_inner = (
    '<g transform="scale(1.5625)" fill="currentColor" fill-rule="evenodd">'
    f'<path d="{LEAF_L}"/><path d="{LEAF_R}"/><path d="{BUD}"/>'
    f'<path d="M {BASE_X},{BASE_Y} L {BASE_X},57" stroke="currentColor" '
    'stroke-width="3.4" stroke-linecap="round"/>'
    "</g>"
)
(HERE / "icon-obsidian-inner.svg").write_text(_inner)

from urllib.parse import quote

uri = 'url("data:image/svg+xml,' + quote(mark_svg(), safe="") + '")'
(HERE / "mark.css").write_text(
    "/* GENERATED by textures/mark.py — do not hand-edit. */\n"
    ".darjeeling-root {\n  --dj-mark: " + uri + ";\n}\n"
)
print(f"  mark.svg  {len(mark_svg())} bytes")
print(f"  icon.svg  {len(icon_svg(512))} bytes")
print(f"  mark.css  {len(uri)} bytes uri")
