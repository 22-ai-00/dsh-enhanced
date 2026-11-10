"""Verify a handoff TSV from the repository root; no files are changed."""

import hashlib
import stat
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 docs/handover/verify-files.py <manifest.tsv>")
    root = Path(__file__).resolve().parents[2]
    manifest = Path(sys.argv[1]).resolve()
    if not manifest.is_relative_to(root / "docs/handover"):
        raise SystemExit("manifest must be inside docs/handover")
    seen = set()
    for line in manifest.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        expected_sha, expected_size, expected_mode, name = line.split("\t")
        path = root / name
        if name in seen or path.is_symlink() or not path.resolve().is_relative_to(root):
            raise SystemExit(f"invalid or repeated path: {name}")
        seen.add(name)
        data = path.read_bytes()
        actual = (hashlib.sha256(data).hexdigest(), len(data), stat.S_IMODE(path.stat().st_mode))
        expected = (expected_sha, int(expected_size), int(expected_mode, 8))
        if actual != expected:
            raise SystemExit(f"FAIL {name}: expected {expected}, got {actual}")
    if not seen:
        raise SystemExit("empty manifest")
    print(f"PASS {len(seen)} files: SHA-256, bytes, mode ({manifest.name})")


if __name__ == "__main__":
    main()
