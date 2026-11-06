#!/usr/bin/env python3
"""Derive the small artwork files committed under `plugins/owner-console/assets/`.

The 11 深海觉醒 source set (`background.png` 1893031 bytes, `icon.png` 1240250 bytes,
both 1254x1254) is far too heavy to inline in the Web client bundle. This script crops
and compresses it once; the derived files are committed, then `build-assets.mjs` inlines
them as data URIs into `src/artwork.ts`.

Usage:
    python3 plugins/owner-console/scripts/prepare-assets.py [SOURCE_DIR]

SOURCE_DIR defaults to `$KUNPENG_ASSET_DIR` or `~/Downloads/kunpeng-11/11_深海觉醒`.
Regenerate only when the source artwork changes; every day-to-day build uses the
committed files under `assets/` and does not need the originals.

Requires Pillow (`python3 -m pip install Pillow`).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from PIL import Image

PLUGIN = Path(__file__).resolve().parent.parent
OUT = PLUGIN / "assets"

# Panel header band: the 1254px square cropped to the 3:1 hero slot. The top band keeps the
# moonlit surface and the whale's head/wing while leaving the left side calm behind nothing.
HERO_BOX = (0, 0, 1254, 418)
HERO_WIDTH = 1254

# Whole-square panel backdrop, reduced to keep the data URI small; rendered at low opacity.
BACKDROP_WIDTH = 960

# Whale glyph crop around the icon's subject: the source icon is mostly empty navy, so a
# square crop around the whale keeps the sidebar mark and the round seal legible at 18-30px.
ICON_BOX = (320, 330, 950, 960)


def source_dir(argv: list[str]) -> Path:
    raw = argv[1] if len(argv) > 1 else os.environ.get(
        "KUNPENG_ASSET_DIR", str(Path.home() / "Downloads/kunpeng-11/11_深海觉醒")
    )
    directory = Path(raw).expanduser().resolve()
    for name in ("background.png", "icon.png"):
        if not (directory / name).is_file():
            raise SystemExit(f"missing {directory / name}; pass the 11_深海觉醒 directory")
    return directory


def save_webp(image: Image.Image, name: str, quality: int) -> None:
    path = OUT / name
    image.save(path, "WEBP", quality=quality, method=6)
    print(f"{name}: {image.width}x{image.height} {path.stat().st_size} bytes")


def main() -> None:
    source = source_dir(sys.argv)
    OUT.mkdir(parents=True, exist_ok=True)
    background = Image.open(source / "background.png").convert("RGB")
    icon = Image.open(source / "icon.png").convert("RGB")

    hero = background.crop(HERO_BOX)
    if hero.width != HERO_WIDTH:
        hero = hero.resize((HERO_WIDTH, round(hero.height * HERO_WIDTH / hero.width)), Image.LANCZOS)
    save_webp(hero, "hero.webp", 72)

    backdrop = background.resize((BACKDROP_WIDTH, BACKDROP_WIDTH), Image.LANCZOS)
    save_webp(backdrop, "backdrop.webp", 68)

    subject = icon.crop(ICON_BOX).resize((128, 128), Image.LANCZOS)
    save_webp(subject, "icon-128.webp", 90)
    calibre = icon.crop(ICON_BOX).resize((256, 256), Image.LANCZOS)
    save_webp(calibre, "icon-256.webp", 88)


if __name__ == "__main__":
    main()
