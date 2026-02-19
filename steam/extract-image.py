#!/usr/bin/env python3
"""
extract-image.py
Extracts the SteamOS rootfs partition from a SteamOS repair image on Windows.
Works without WSL, Docker, or 7-Zip — uses only Python stdlib.

Usage:
    python steam/extract-image.py
    python steam/extract-image.py --source C:\\path\\to\\image.bz2 --outdir steam\\

Output:
    steam\\steamos-rootfs.img  (raw ext4 partition image)
"""

import sys, os, struct, bz2, argparse, time, shutil

DEFAULT_SOURCE = os.path.join(os.environ.get("USERPROFILE", "C:\\Users\\Dan"),
                               "Downloads", "steamdeck-repair-20250521.10-3.7.7.img.bz2")
DEFAULT_OUTDIR = os.path.dirname(os.path.abspath(__file__))

# ── GPT constants ────────────────────────────────────────────────────────────
GPT_HEADER_OFFSET  = 512      # LBA 1
GPT_HEADER_SIZE    = 92
GPT_ENTRY_SIZE     = 128
SECTOR_SIZE        = 512

# Well-known SteamOS rootfs GUID
# SteamOS uses standard Linux filesystem GUID for rootfs partitions
LINUX_DATA_GUID = "0FC63DAF-8483-4772-8E79-3D69D8477DE4"

def log(msg): print(f"[webx] {msg}", flush=True)

def read_gpt(f):
    """Parse GPT and return list of (name, start_lba, end_lba, type_guid) tuples."""
    f.seek(GPT_HEADER_OFFSET)
    sig = f.read(8)
    if sig != b"EFI PART":
        raise ValueError(f"No GPT header found (got {sig!r}). Image may use MBR.")

    f.seek(GPT_HEADER_OFFSET)
    hdr = f.read(GPT_HEADER_SIZE)
    (_, _, _, _, _, _, _, _, _, _,
     part_start_lba, _, part_count, part_entry_size) = struct.unpack_from(
        "<8sIIIIQQQQ16sQIII", hdr, 0)[:14]

    # Re-parse correctly
    hdr_data = struct.unpack("<8sIIIIQQQQ16sQIII", hdr)
    part_start_lba  = hdr_data[10]
    part_count      = hdr_data[11]
    part_entry_size = hdr_data[12]

    partitions = []
    f.seek(part_start_lba * SECTOR_SIZE)
    for i in range(min(part_count, 128)):
        entry = f.read(part_entry_size)
        if len(entry) < 128: break

        type_guid_raw   = entry[0:16]
        unique_guid_raw = entry[16:32]
        start_lba       = struct.unpack_from("<Q", entry, 32)[0]
        end_lba         = struct.unpack_from("<Q", entry, 40)[0]
        name_raw        = entry[56:128]

        if start_lba == 0: continue  # empty entry

        # Decode GUID
        def fmt_guid(b):
            p1 = struct.unpack_from("<IHH", b, 0)
            p2 = b[8:10].hex().upper()
            p3 = b[10:16].hex().upper()
            return f"{p1[0]:08X}-{p1[1]:04X}-{p1[2]:04X}-{p2}-{p3}"

        type_guid = fmt_guid(type_guid_raw)
        name = name_raw.decode("utf-16-le").rstrip("\x00")
        partitions.append((name, start_lba, end_lba, type_guid))
        log(f"  Part {i+1:2d}: [{name:20s}] LBA {start_lba}–{end_lba}"
            f"  ({(end_lba-start_lba+1)*512//1024//1024:5d} MB)  {type_guid}")

    return partitions


def find_rootfs_partition(partitions):
    """Pick the best rootfs partition (prefer 'rootfs' name, else largest ext4)."""
    # SteamOS names: 'rootfs', 'root-A', 'SteamOS', 'root'
    candidates = [p for p in partitions
                  if any(k in p[0].lower() for k in ("root", "steam", "system"))]
    if not candidates:
        candidates = [p for p in partitions if p[3] == LINUX_DATA_GUID]
    if not candidates:
        raise ValueError("Cannot identify rootfs partition. "
                         "List above shows all partitions — pick manually.")
    # Prefer largest
    return max(candidates, key=lambda p: p[2] - p[1])


def decompress_bz2_streaming(src, dst_path):
    """Decompress a .bz2 file to dst_path with progress reporting."""
    log(f"Decompressing {os.path.basename(src)} ...")
    src_size = os.path.getsize(src)
    written = 0
    start = time.time()

    with open(src, "rb") as fin, open(dst_path, "wb") as fout:
        decompressor = bz2.BZ2Decompressor()
        chunk = 4 * 1024 * 1024  # 4 MB chunks
        while True:
            compressed = fin.read(chunk)
            if not compressed:
                break
            data = decompressor.decompress(compressed)
            fout.write(data)
            written += len(data)
            elapsed = time.time() - start
            pct = fin.tell() / src_size * 100
            speed = written / elapsed / 1024 / 1024 if elapsed > 0 else 0
            print(f"\r  {pct:5.1f}%  {written//1024//1024:,} MB written"
                  f"  {speed:.1f} MB/s  ", end="", flush=True)
    print()
    log(f"Decompressed: {written//1024//1024:,} MB")
    return dst_path


def extract_partition(img_path, start_lba, end_lba, out_path):
    """Extract a single partition from img_path to out_path."""
    part_size = (end_lba - start_lba + 1) * SECTOR_SIZE
    log(f"Extracting partition: LBA {start_lba}–{end_lba} ({part_size//1024//1024} MB)")

    chunk = 4 * 1024 * 1024
    written = 0
    start = time.time()

    with open(img_path, "rb") as fin, open(out_path, "wb") as fout:
        fin.seek(start_lba * SECTOR_SIZE)
        remaining = part_size
        while remaining > 0:
            to_read = min(chunk, remaining)
            data = fin.read(to_read)
            if not data: break
            fout.write(data)
            written += len(data)
            remaining -= len(data)
            elapsed = time.time() - start
            pct = written / part_size * 100
            speed = written / elapsed / 1024 / 1024 if elapsed > 0 else 0
            print(f"\r  {pct:5.1f}%  {written//1024//1024:,} MB  {speed:.1f} MB/s  ",
                  end="", flush=True)
    print()
    log(f"Extracted: {written//1024//1024} MB -> {out_path}")


def main():
    ap = argparse.ArgumentParser(description="Extract SteamOS rootfs for CheerpX")
    ap.add_argument("--source", default=DEFAULT_SOURCE)
    ap.add_argument("--outdir", default=DEFAULT_OUTDIR)
    ap.add_argument("--skip-decompress", action="store_true",
                    help="Skip decompression if .img already exists")
    ap.add_argument("--partition", type=int, default=None,
                    help="Force partition index (1-based) instead of auto-detect")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    img_path    = os.path.join(args.outdir, "steamdeck-repair.img")
    rootfs_path = os.path.join(args.outdir, "steamos-rootfs.img")

    # ── 1. Decompress .bz2 ────────────────────────────────────────────
    if args.skip_decompress and os.path.exists(img_path):
        log(f"Using existing {img_path}")
    else:
        if not os.path.exists(args.source):
            print(f"ERROR: Source not found: {args.source}")
            print("Update --source or place the .bz2 in Downloads/")
            sys.exit(1)
        decompress_bz2_streaming(args.source, img_path)

    # ── 2. Parse GPT ──────────────────────────────────────────────────
    log("Reading partition table...")
    with open(img_path, "rb") as f:
        try:
            partitions = read_gpt(f)
        except ValueError as e:
            log(f"GPT error: {e}")
            log("Trying MBR...")
            # MBR fallback: partition 2 at offset is typical for SteamOS
            partitions = None

    if not partitions:
        log("Cannot parse partition table automatically.")
        log("Manually specify partition with: --partition 2")
        sys.exit(1)

    # ── 3. Choose rootfs partition ────────────────────────────────────
    if args.partition:
        part = partitions[args.partition - 1]
        log(f"Using specified partition {args.partition}: {part[0]}")
    else:
        part = find_rootfs_partition(partitions)
        log(f"Auto-selected rootfs: {part[0]}")

    name, start_lba, end_lba, type_guid = part

    # ── 4. Extract partition ──────────────────────────────────────────
    extract_partition(img_path, start_lba, end_lba, rootfs_path)

    # ── 5. Report ─────────────────────────────────────────────────────
    size_mb = os.path.getsize(rootfs_path) // 1024 // 1024
    print()
    log("─" * 60)
    log(f"Rootfs image: {rootfs_path}")
    log(f"Size: {size_mb:,} MB")
    log("")
    log("Next steps:")
    log("  The image is ext4. CheerpX expects ext2.")
    log("  To convert, you need Linux tools (tune2fs, e2fsck).")
    log("")
    log("  Option A — Miniconda Python + ext4fuse (Windows):")
    log("    Not available — ext4 tools require Linux kernel drivers.")
    log("")
    log("  Option B — Git Bash + install e2fsprogs (may not work on Windows):")
    log("    Not reliable without WSL.")
    log("")
    log("  Option C — Fix WSL2 registration:")
    log("    1. Open 'Turn Windows features on or off'")
    log("    2. Enable 'Windows Subsystem for Linux' + 'Virtual Machine Platform'")
    log("    3. Reboot, then: wsl --install Ubuntu")
    log("    4. Run: bash steam/extract-rootfs.sh steam/steamdeck-repair.img steam/")
    log("")
    log("  Option D — Use CheerpX with raw ext4 (test if it works):")
    log("    CheerpX may accept ext4 directly — try serving steamos-rootfs.img")
    log("    as-is and adjust the mount type in cheerpx-host.mjs to 'ext2'.")
    log("    The journal will be ignored if tune2fs isn't available.")
    log("")
    log("  Option E — Install Docker Desktop and run extract-image.ps1.")


if __name__ == "__main__":
    main()
