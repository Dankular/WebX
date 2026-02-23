#!/usr/bin/env bash
# extract-rootfs.sh
# Runs in WSL2 or Linux. Extracts the rootfs partition from the SteamOS
# repair image and installs the WebX guest ICD.
# Handles both ext4 and btrfs rootfs (SteamOS 3.x uses btrfs).
#
# Usage:
#   bash extract-rootfs.sh <path-to.img> <output-dir>
#
# Output:
#   <output-dir>/steamos-webx.ext2   (ext2 image for Canary)

set -euo pipefail
IMG="$1"
OUT="$2"

ROOTFS_IMG="$OUT/steamos-rootfs.img"
MOUNT_IMG="$OUT/steamdeck-repair.img"
LOOP=""
BTRFS_MOUNT=/tmp/webx-btrfs-rootfs
EXT2_MOUNT=/tmp/webx-ext2-rootfs

cleanup() {
    [ -n "$LOOP" ] && sudo losetup -d "$LOOP" 2>/dev/null || true
    sudo umount "$BTRFS_MOUNT" 2>/dev/null || true
    sudo umount "$EXT2_MOUNT" 2>/dev/null || true
    sudo umount /tmp/webx-rootfs 2>/dev/null || true
}
trap cleanup EXIT

install_icd() {
    local MNT="$1"
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

    echo "[webx] Installing WebX guest ICD..."

    if [ -f "$REPO_ROOT/build/guest-icd/libvkwebx.so" ]; then
        sudo install -m 755 "$REPO_ROOT/build/guest-icd/libvkwebx.so" \
            "$MNT/usr/local/lib/libvkwebx.so"
    else
        echo "[webx] WARNING: libvkwebx.so not built yet. Run: npm run build:icd"
    fi

    sudo mkdir -p "$MNT/etc/vulkan/icd.d"
    sudo install -m 644 "$REPO_ROOT/guest-icd/vkwebx_icd.json" \
        "$MNT/etc/vulkan/icd.d/vkwebx_icd.json"

    sudo rm -f "$MNT/etc/vulkan/icd.d/intel_"*.json \
               "$MNT/etc/vulkan/icd.d/radeon"*.json \
               "$MNT/etc/vulkan/icd.d/nvidia"*.json \
               "$MNT/etc/vulkan/icd.d/lvp"*.json \
               "$MNT/etc/vulkan/icd.d/dzn"*.json 2>/dev/null || true

    sudo mkdir -p "$MNT/opt/webx"
    sudo install -m 755 "$REPO_ROOT/steam/launch.sh" \
        "$MNT/opt/webx/launch.sh"
}

# ── 1. Set up loop device ──────────────────────────────────────────────
echo "[webx] Attaching loop device to $MOUNT_IMG..."
LOOP=$(sudo losetup -fP --show "$MOUNT_IMG")
echo "[webx] Loop device: $LOOP"

# ── 2. List partitions ────────────────────────────────────────────────
echo "[webx] Partition layout:"
sudo fdisk -l "$LOOP" 2>/dev/null || sudo parted "$LOOP" print

# SteamOS repair image partition layout (steamdeck-repair-*.img):
#   p1: 64 MB  EFI System
#   p2: 128 MB Microsoft basic data (recovery/ESP)
#   p3: 5 GB   Linux root x86-64  ← rootfs A (btrfs on SteamOS 3.x)
#   p4: 256 MB Linux variable data
#   p5: 1.6 GB Linux home
ROOTFS_PART="${LOOP}p3"
echo "[webx] Using rootfs partition: $ROOTFS_PART"

# ── 3. Copy rootfs partition to raw image (skip if already done) ────────
PART_SIZE=$(sudo blockdev --getsize64 "$ROOTFS_PART")
echo "[webx] Rootfs partition size: $((PART_SIZE / 1024 / 1024)) MB"

if [ -f "$ROOTFS_IMG" ] && [ "$(stat -c%s "$ROOTFS_IMG")" -ge "$PART_SIZE" ]; then
    echo "[webx] steamos-rootfs.img already exists and is complete — skipping dd."
    echo "[webx] Delete $ROOTFS_IMG and re-run to force re-extraction."
else
    echo "[webx] Copying rootfs partition (this will take several minutes)..."
    sudo dd if="$ROOTFS_PART" of="$ROOTFS_IMG" bs=4M status=progress conv=sparse
fi

# ── 4. Detect filesystem type ──────────────────────────────────────────
FS_TYPE=$(sudo blkid -o value -s TYPE "$ROOTFS_IMG" 2>/dev/null || echo "unknown")
echo "[webx] Rootfs filesystem type: $FS_TYPE"

FINAL="$OUT/steamos-webx.ext2"

if [ "$FS_TYPE" = "btrfs" ]; then
    # ── 5a. btrfs → ext2 via mount + rsync ────────────────────────────
    echo "[webx] btrfs rootfs — converting to ext2 via rsync..."

    if ! command -v btrfs &>/dev/null; then
        echo "[webx] Installing btrfs-progs..."
        sudo apt-get install -y btrfs-progs
    fi

    sudo mkdir -p "$BTRFS_MOUNT"
    sudo mount -t btrfs -o loop,ro "$ROOTFS_IMG" "$BTRFS_MOUNT"

    # Measure true uncompressed size (du -sb) + 1536 MB headroom
    echo "[webx] Measuring uncompressed content size (takes ~30s)..."
    USED=$(sudo du -sb "$BTRFS_MOUNT" 2>/dev/null | awk '{print $1}')
    EXT2_SIZE=$(( (USED / 1024 / 1024) + 1536 ))
    echo "[webx] Uncompressed: $((USED / 1024 / 1024)) MB — creating ${EXT2_SIZE} MB ext2 image..."

    sudo dd if=/dev/zero of="$FINAL" bs=1M count="$EXT2_SIZE" status=progress
    sudo mkfs.ext2 -L rootfs -m 1 "$FINAL"

    sudo mkdir -p "$EXT2_MOUNT"
    sudo mount -o loop "$FINAL" "$EXT2_MOUNT"

    echo "[webx] Rsyncing rootfs (btrfs → ext2), this takes ~15 min..."
    sudo rsync -aH --info=progress2 "$BTRFS_MOUNT/" "$EXT2_MOUNT/"

    sudo umount "$BTRFS_MOUNT"

    install_icd "$EXT2_MOUNT"
    sudo chroot "$EXT2_MOUNT" /sbin/ldconfig 2>/dev/null || true
    sudo umount "$EXT2_MOUNT"

else
    # ── 5b. ext4 → ext2 via tune2fs (legacy) ──────────────────────────
    echo "[webx] ext4 rootfs — using resize2fs/tune2fs approach..."

    echo "[webx] Expanding image by 256 MB for WebX ICD..."
    sudo e2fsck -fy "$ROOTFS_IMG" || true
    sudo resize2fs "$ROOTFS_IMG" "$((PART_SIZE / 1024 / 1024 + 256))M"

    sudo mkdir -p /tmp/webx-rootfs
    sudo mount "$ROOTFS_IMG" /tmp/webx-rootfs

    install_icd "/tmp/webx-rootfs"
    sudo chroot /tmp/webx-rootfs /sbin/ldconfig 2>/dev/null || true
    sudo umount /tmp/webx-rootfs

    cp "$ROOTFS_IMG" "$FINAL"
    sudo tune2fs -O ^extent,^flex_bg,^has_journal,^huge_file,^uninit_bg "$FINAL" 2>/dev/null || true
    sudo e2fsck -f "$FINAL" || true
fi

echo ""
echo "[webx] ── Done ─────────────────────────────────────────────────────"
echo "  Image: $FINAL"
echo "  Size:  $(($(stat -c%s "$FINAL") / 1024 / 1024)) MB"
echo ""
echo "  Serve at /steam/steamos-webx.ext2 (needs COOP/COEP headers)."
echo "  Update STEAMOS_IMAGE_URL in harness/canary-host.mjs if you move it."
