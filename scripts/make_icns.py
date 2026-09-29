#!/usr/bin/env python3
"""Pack PNG icon files into a macOS .icns container.

Usage:
  make_icns.py OUTPUT.icns SIZE:PATH [SIZE:PATH ...]

Example:
  make_icns.py AppIcon.icns 32:icon-32.png 128:icon-128.png 512:icon-512.png

The .icns format is a simple tagged container — each entry is a 4-char
type code, a uint32 BE size (including the 8-byte header), and raw data
(PNG bytes for modern type codes).
"""
import struct
import sys

# Map size in px → type code that expects a PNG of exactly that size.
# Modern macOS reads PNG-tagged slots from these codes:
PNG_SLOTS = {
    16: b"icp4",
    32: b"icp5",
    64: b"icp6",
    128: b"ic07",
    256: b"ic08",
    512: b"ic09",
    1024: b"ic10",
}


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    out_path = sys.argv[1]
    entries = []
    for spec in sys.argv[2:]:
        size_str, path = spec.split(":", 1)
        size = int(size_str)
        if size not in PNG_SLOTS:
            print(f"Unsupported size {size}; valid: {sorted(PNG_SLOTS)}",
                  file=sys.stderr)
            sys.exit(1)
        with open(path, "rb") as f:
            data = f.read()
        entries.append((PNG_SLOTS[size], data))

    body = b""
    for type_code, data in entries:
        body += type_code + struct.pack(">I", 8 + len(data)) + data

    total = 8 + len(body)
    with open(out_path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", total) + body)
    print(f"Wrote {out_path} ({total} bytes, {len(entries)} sizes)")


if __name__ == "__main__":
    main()
