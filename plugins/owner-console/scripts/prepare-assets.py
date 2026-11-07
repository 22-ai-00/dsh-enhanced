#!/usr/bin/env python3
"""Derive the small artwork files committed under `plugins/owner-console/assets/`.

The 02 水墨化鹏 source set (`background.png` 1672x941, `icon.png` 1254x1254) is far
too heavy to inline in the Web client bundle. This script compresses it once; the
derived files are committed, then `build-assets.mjs` inlines them as data URIs into
`src/artwork.ts`.

Usage:
    python3 plugins/owner-console/scripts/prepare-assets.py [SOURCE_DIR]

SOURCE_DIR defaults to `$WENYAO_ASSET_DIR` or `~/Downloads/02_水墨化鹏_副本`.
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

# Settings banner: the wide background (1672x941) scaled to 1254px, keeping the whole
# fish-to-peng composition rather than cropping a 3:1 band.
HERO_WIDTH = 1254

# Whole-background panel backdrop, reduced to keep the data URI small; rendered at low
# opacity behind the chat and settings surfaces.
BACKDROP_WIDTH = 960

# Icon glyph crop around the fish-and-peng roundel: the source is paper-toned with a
# lot of margin, so a square around the subject keeps the sidebar mark and seal legible
# at 18-30px while retaining the red sun and the bird's wing.
ICON_BOX = (210, 157, 1090, 1037)


def source_dir(argv: list[str]) -> Path:
    raw = argv[1] if len(argv) > 1 else os.environ.get(
        "WENYAO_ASSET_DIR", str(Path.home() / "Downloads/02_水墨化鹏_副本")
    )
    directory = Path(raw).expanduser().resolve()
    for name in ("background.png", "icon.png"):
        if not (directory / name).is_file():
            raise SystemExit(f"missing {directory / name}; pass the 02 水墨化鹏 directory")
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

    hero = background.copy()
    if hero.width != HERO_WIDTH:
        hero = hero.resize((HERO_WIDTH, round(hero.height * HERO_WIDTH / hero.width)), Image.LANCZOS)
    save_webp(hero, "hero.webp", 72)

    backdrop = background.resize((BACKDROP_WIDTH, round(background.height * BACKDROP_WIDTH / background.width)), Image.LANCZOS)
    save_webp(backdrop, "backdrop.webp", 68)

    subject = icon.crop(ICON_BOX).resize((128, 128), Image.LANCZOS)
    save_webp(subject, "icon-128.webp", 90)
    calibre = icon.crop(ICON_BOX).resize((256, 256), Image.LANCZOS)
    save_webp(calibre, "icon-256.webp", 88)


if __name__ == "__main__":
    main()
