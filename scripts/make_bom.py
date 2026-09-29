#!/usr/bin/env python3
"""
Minimal BOM (Bill of Materials) generator for macOS package installers.
Implements enough of the Apple BOM format to produce valid .pkg Bom files.
Based on the reverse-engineered format documented by bomutils and various OSS projects.
"""

import os
import stat
import struct
import sys


def pb(fmt, *args):
    return struct.pack(">" + fmt, *args)


class BOMBuilder:
    """Builds a flat BOM file for a directory tree (single-leaf B-tree)."""

    def __init__(self):
        # Block 0 is always the null block (offset 0, length 0)
        self._blocks: list[bytes] = [b""]

    def _add(self, data: bytes) -> int:
        idx = len(self._blocks)
        self._blocks.append(data)
        return idx

    def build(self, root_dir: str) -> bytes:
        root_dir = os.path.realpath(root_dir)

        # ── Collect all filesystem entries ──────────────────────────────
        # entries: list of (full_path, name, parent_entry_idx, os.stat_result)
        # Entry index 1 = root directory
        entries: list[tuple[str, str, int, os.stat_result]] = []

        root_st = os.lstat(root_dir)
        entries.append((root_dir, ".", 0, root_st))  # index 0 (1-based → 1)

        def collect(dir_path: str, parent_1based: int):
            try:
                names = sorted(os.listdir(dir_path))
            except PermissionError:
                return
            for name in names:
                full = os.path.join(dir_path, name)
                try:
                    st = os.lstat(full)
                except OSError:
                    continue
                entry_1based = len(entries) + 1
                entries.append((full, name, parent_1based, st))
                if stat.S_ISDIR(st.st_mode):
                    collect(full, entry_1based)

        collect(root_dir, 1)

        # ── Build value blocks (BOMPathRecord) and key blocks (BOMFile) ─
        tree_pairs: list[tuple[int, int]] = []  # (val_blk, key_blk) per entry

        for i, (full_path, name, parent_1based, st) in enumerate(entries):
            entry_1based = i + 1

            # Determine type byte
            mode = st.st_mode
            if stat.S_ISDIR(mode):
                typ = 2  # directory
                size = 0
            elif stat.S_ISLNK(mode):
                typ = 3  # symlink
                size = st.st_size
            else:
                typ = 1  # regular file
                size = st.st_size

            fmode = mode & 0xFFFF
            uid = st.st_uid
            gid = st.st_gid
            mtime = int(st.st_mtime)
            link_name = b""
            if stat.S_ISLNK(mode):
                try:
                    link_name = os.readlink(full_path).encode() + b"\x00"
                except OSError:
                    pass

            # BOMPathRecord (20 bytes + optional link name)
            path_rec = (
                pb("B", typ) +          # type
                pb("B", 1) +            # unknown0 = 1
                pb("H", 0) +            # architecture = 0
                pb("H", fmode) +        # mode
                pb("I", uid) +          # user
                pb("I", gid) +          # group
                pb("I", mtime) +        # modtime
                pb("I", size) +         # size
                pb("B", 1) +            # unknown1 = 1
                pb("I", 0) +            # checksum = 0
                pb("I", len(link_name)) +  # linkNameLength
                link_name
            )
            val_blk = self._add(path_rec)

            # BOMFile: 4-byte parent index (1-based, 0 for root) + name + NUL
            # Root directory uses parent = 0
            par = 0 if i == 0 else parent_1based
            bom_file = pb("I", par) + name.encode("utf-8") + b"\x00"
            key_blk = self._add(bom_file)

            tree_pairs.append((val_blk, key_blk))

        # ── BOMTreeEntryList (single leaf node containing all entries) ───
        count = len(tree_pairs)
        leaf = pb("HHH", count, 0, 0)   # count, forward=0, backward=0
        for val_blk, key_blk in tree_pairs:
            leaf += pb("II", val_blk, key_blk)
        leaf_blk = self._add(leaf)

        # ── BOMTree for Paths ────────────────────────────────────────────
        paths_tree = (
            b"tree" +
            pb("I", 1) +            # version = 1
            pb("I", leaf_blk) +     # child (root node block index)
            pb("I", 4096) +         # blockSize
            pb("I", count) +        # pathCount
            pb("B", 0)              # unknown = 0
        )
        paths_blk = self._add(paths_tree)

        # ── Empty HLIndex tree (no hard links) ───────────────────────────
        hl_leaf = pb("HHH", 0, 0, 0)
        hl_leaf_blk = self._add(hl_leaf)
        hl_tree = (
            b"tree" +
            pb("I", 1) +
            pb("I", hl_leaf_blk) +
            pb("I", 4096) +
            pb("I", 0) +
            pb("B", 0)
        )
        hl_blk = self._add(hl_tree)

        # ── BomInfo ──────────────────────────────────────────────────────
        info = (
            pb("I", 1) +      # version
            pb("I", count) +  # count
            pb("I", 0) * 3    # padding
        )
        info_blk = self._add(info)

        # ── Assemble the binary ──────────────────────────────────────────
        # Layout: [Header:512 bytes][block data][block index][vars]

        # Compute block data and offsets
        HEADER_SIZE = 512
        raw_data = b""
        # block 0: null, offset=0, length=0
        blk_offsets = [(0, 0)]
        cur = HEADER_SIZE
        for blk in self._blocks[1:]:
            blk_offsets.append((cur, len(blk)))
            raw_data += blk
            cur += len(blk)

        # Block index: numberOfBlocks + (offset, length) pairs,
        # followed by the FreeList: numberOfFreeBlocks + (offset, length) pairs.
        # macOS PackageKit will crash in _ReadFreeList if the FreeList
        # count is missing — even with zero free blocks, the count must
        # be present.
        n = len(self._blocks)
        index = pb("I", n)
        for off, ln in blk_offsets:
            index += pb("II", off, ln)
        # FreeList: zero free blocks, but the count field is mandatory
        index += pb("I", 0)

        # Vars section
        vars_list = [
            ("Paths",   paths_blk),
            ("HLIndex", hl_blk),
            ("BomInfo", info_blk),
        ]
        vars_section = pb("I", len(vars_list))
        for vname, vblk in vars_list:
            nb = vname.encode()
            vars_section += pb("I", vblk) + struct.pack("B", len(nb)) + nb

        index_offset = HEADER_SIZE + len(raw_data)
        index_length = len(index)
        vars_offset = index_offset + index_length
        vars_length = len(vars_section)

        header = (
            b"BOMStore" +
            pb("I", 1) +              # version
            pb("I", n) +              # numberOfBlocks
            pb("I", index_offset) +
            pb("I", index_length) +
            pb("I", vars_offset) +
            pb("I", vars_length)
        )
        header += b"\x00" * (HEADER_SIZE - len(header))

        return header + raw_data + index + vars_section


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <source-dir> <output.bom>", file=sys.stderr)
        sys.exit(1)
    source = sys.argv[1]
    output = sys.argv[2]
    bom_data = BOMBuilder().build(source)
    with open(output, "wb") as f:
        f.write(bom_data)
    print(f"Written {len(bom_data)} bytes → {output}")
