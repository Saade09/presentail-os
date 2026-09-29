#!/usr/bin/env python3
"""
Build a macOS-compatible .pkg (xar) archive from staged files.

Why this exists:
  Linux's `xar` tool (forked from Apple's xar years ago) writes raw zlib
  (magic 78 da) but tags entries as application/x-gzip in the TOC.
  macOS's BOMCopier expects actual gzip-wrapped data (magic 1f 8b 08)
  when the TOC says gzip, and rejects raw zlib with
  "cpio read error: bad file format". This script writes the xar
  archive byte-by-byte with proper gzip framing.

xar layout (big-endian where multi-byte):
  [ 28-byte header ]
  [ zlib-compressed TOC XML (toc_compressed_size bytes) ]
  [ 20-byte SHA-1 of the compressed TOC ]
  [ heap: each file's data, in TOC order, no padding ]

Usage:
  python3 make_xar.py OUTPUT.pkg name1=file1 name2=file2 ...
"""

import gzip
import hashlib
import os
import struct
import sys
import zlib
from datetime import datetime, timezone


def build_xar(output_path: str, entries: list[tuple[str, str]]) -> None:
    """entries is a list of (name_in_archive, path_on_disk)."""
    # ── Build heap & per-file metadata ────────────────────────────────
    heap = bytearray()
    file_meta = []
    # Heap offset 0..19 is reserved for the SHA-1 of the compressed TOC.
    cursor = 20

    for fid, (name, path) in enumerate(entries, start=1):
        with open(path, "rb") as f:
            raw = f.read()

        # Use Python's gzip module → proper gzip framing (1f 8b 08 ...)
        # mtime=0 makes builds reproducible.
        gz = gzip.compress(raw, compresslevel=9, mtime=0)

        file_meta.append(
            {
                "id": fid,
                "name": name,
                "size": len(raw),
                "length": len(gz),
                "offset": cursor,
                "extracted_sha1": hashlib.sha1(raw).hexdigest(),
                "archived_sha1": hashlib.sha1(gz).hexdigest(),
            }
        )
        heap += gz
        cursor += len(gz)

    # ── Build TOC XML ─────────────────────────────────────────────────
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    toc_lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<xar>",
        " <toc>",
        '  <checksum style="sha1">',
        "   <size>20</size>",
        "   <offset>0</offset>",
        "  </checksum>",
        f"  <creation-time>{now}</creation-time>",
    ]

    for m in file_meta:
        toc_lines += [
            f'  <file id="{m["id"]}">',
            f"   <name>{m['name']}</name>",
            "   <type>file</type>",
            f"   <inode>{m['id']}</inode>",
            "   <deviceno>0</deviceno>",
            "   <mode>0644</mode>",
            "   <uid>0</uid>",
            "   <user>root</user>",
            "   <gid>0</gid>",
            "   <group>wheel</group>",
            f"   <atime>{now}</atime>",
            f"   <mtime>{now}</mtime>",
            f"   <ctime>{now}</ctime>",
            "   <data>",
            f"    <archived-checksum style=\"sha1\">{m['archived_sha1']}</archived-checksum>",
            f"    <extracted-checksum style=\"sha1\">{m['extracted_sha1']}</extracted-checksum>",
            '    <encoding style="application/x-gzip"/>',
            f"    <size>{m['size']}</size>",
            f"    <offset>{m['offset']}</offset>",
            f"    <length>{m['length']}</length>",
            "   </data>",
            "  </file>",
        ]

    toc_lines += [" </toc>", "</xar>"]
    toc_xml = "\n".join(toc_lines).encode("utf-8")
    toc_compressed = zlib.compress(toc_xml, level=9)
    toc_sha1 = hashlib.sha1(toc_compressed).digest()

    # ── Header ────────────────────────────────────────────────────────
    # magic(4) hdr_size(2) version(2) toc_csize(8) toc_size(8) ckalg(4)
    # ckalg: 0=none, 1=sha1, 2=md5, 3=sha256, 4=sha512
    header = struct.pack(
        ">4sHHQQI",
        b"xar!",
        28,
        1,
        len(toc_compressed),
        len(toc_xml),
        1,  # SHA-1
    )

    # ── Write the file ────────────────────────────────────────────────
    with open(output_path, "wb") as f:
        f.write(header)
        f.write(toc_compressed)
        f.write(toc_sha1)
        f.write(heap)

    print(
        f"Wrote {output_path}: header=28 toc={len(toc_compressed)} "
        f"sha1=20 heap={len(heap)} total={28 + len(toc_compressed) + 20 + len(heap)} bytes"
    )


def main() -> None:
    if len(sys.argv) < 3:
        print("usage: make_xar.py OUTPUT.pkg name=path [name=path ...]", file=sys.stderr)
        sys.exit(2)

    output = sys.argv[1]
    entries: list[tuple[str, str]] = []
    for arg in sys.argv[2:]:
        if "=" not in arg:
            print(f"invalid entry (expected name=path): {arg}", file=sys.stderr)
            sys.exit(2)
        name, path = arg.split("=", 1)
        if not os.path.isfile(path):
            print(f"file not found: {path}", file=sys.stderr)
            sys.exit(2)
        entries.append((name, path))

    build_xar(output, entries)


if __name__ == "__main__":
    main()
