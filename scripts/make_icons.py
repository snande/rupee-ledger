#!/usr/bin/env python3
"""Draw the Rupee Ledger install icons: a flat paper-coloured rupee glyph on
a haldi square, both colours from the DESIGN.md palette.

Writes into icons/:
  - icon-192.png           192x192, purpose "any"
  - icon-512.png           512x512, purpose "any"
  - icon-maskable-512.png  512x512, purpose "maskable": the glyph stays inside
                           the central safe circle (radius 40%) so any mask
                           shape the platform applies leaves it whole
  - apple-touch-icon.png   180x180, for iOS Safari's home screen

The glyph is built from bars, a half ring and a diagonal stroke rather than
a font, so the output is the same on every machine. Standard library only.

Usage: python3 scripts/make_icons.py [repo-root]
"""

import struct
import sys
import zlib
from pathlib import Path

HALDI = (0xD9, 0x8E, 0x04)
PAPER = (0xFA, 0xF6, 0xEE)
SUPERSAMPLE = 3

# (file name, pixel size, glyph box as a fraction of the icon side)
ICONS = (
    ("icon-192.png", 192, 0.58),
    ("icon-512.png", 512, 0.58),
    ("icon-maskable-512.png", 512, 0.46),
    ("apple-touch-icon.png", 180, 0.58),
)

STROKE = 0.1


def in_glyph(x, y):
    """True when (x, y), in the glyph's own 0..1 box, is inked."""
    if not (0 <= x <= 1 and 0 <= y <= 1):
        return False
    # Top bar and the second bar across the bowl.
    if y <= STROKE or 0.25 <= y <= 0.25 + STROKE:
        return True
    # Bowl: right half of a ring whose top meets the top bar.
    cx, cy, outer = 0.4, 0.3, 0.3
    if x >= cx:
        d2 = (x - cx) ** 2 + (y - cy) ** 2
        if (outer - STROKE) ** 2 <= d2 <= outer ** 2:
            return True
    # Foot of the bowl running back to the left.
    if 0.05 <= x <= cx and 0.6 - STROKE <= y <= 0.6:
        return True
    # Diagonal leg from the foot down to the bottom right.
    return near_segment(x, y, (0.12, 0.55), (0.72, 1.0), STROKE / 2)


def near_segment(x, y, a, b, radius):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    px, py = ax + t * dx, ay + t * dy
    return (x - px) ** 2 + (y - py) ** 2 <= radius ** 2


def render(size, box):
    origin = (1 - box) / 2
    samples = SUPERSAMPLE * SUPERSAMPLE
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter type 0 for this scanline
        for px in range(size):
            hits = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    u = (px + (sx + 0.5) / SUPERSAMPLE) / size
                    v = (py + (sy + 0.5) / SUPERSAMPLE) / size
                    if in_glyph((u - origin) / box, (v - origin) / box):
                        hits += 1
            k = hits / samples
            row += bytes(round(bg + (fg - bg) * k) for bg, fg in zip(HALDI, PAPER))
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main(argv):
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent
    out = root / "icons"
    out.mkdir(exist_ok=True)
    for name, size, box in ICONS:
        (out / name).write_bytes(png(size, render(size, box)))
        print(f"wrote icons/{name} ({size}x{size})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
