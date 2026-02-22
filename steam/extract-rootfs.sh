#!/usr/bin/env bash
# extract-rootfs.sh
# Runs in WSL2 or Linux. Extracts the rootfs partition from the SteamOS
# repair image and installs the WebX guest ICD.
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

cleanup() {
    [ -n "$LOOP" ] && sudo losetup -d "$LOOP" 2>/dev/null || true
    sudo umount /tmp/webx-rootfs 2>/dev/null || true
}
trap cleanup EXIT

# ── 1. Set up loop device ──────────────────────────────────────────────
echo "[webx] Attaching loop device to $MOUNT_IMG..."
LOOP=$(sudo losetup -fP --show "$MOUNT_IMG")
echo "[webx] Loop device: $LOOP"

# ── 2. List partitions ────────────────────────────────────────────────
echo "[webx] Partition layout:"
sudo fdisk -l "$LOOP" 2>/dev/null || sudo parted "$LOOP" print

# SteamOS partition 2 = rootfs A (the active slot in repair images)
ROOTFS_PART="${LOOP}p2"
echo "[webx] Using rootfs partition: $ROOTFS_PART"

# ── 3. Copy rootfs partition to output image ──────────────────────────
echo "[webx] Copying rootfs partition (this will take several minutes)..."
PART_SIZE=$(sudo blockdev --getsize64 "$ROOTFS_PART")
echo "[webx] Rootfs partition size: $((PART_SIZE / 1024 / 1024)) MB"

sudo dd if="$ROOTFS_PART" of="$ROOTFS_IMG" bs=4M status=progress conv=sparse

# ── 4. Grow image slightly for our additions ──────────────────────────
echo "[webx] Expanding image by 256 MB for WebX ICD..."
sudo e2fsck -f "$ROOTFS_IMG" || true
sudo resize2fs "$ROOTFS_IMG" "$((PART_SIZE / 1024 / 1024 + 256))M"

# ── 5. Mount and install WebX ICD ────────────────────────────────────
sudo mkdir -p /tmp/webx-rootfs
sudo mount "$ROOTFS_IMG" /tmp/webx-rootfs

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "[webx] Installing WebX guest ICD..."

# ICD shared library
if [ -f "$REPO_ROOT/build/guest-icd/libvkwebx.so" ]; then
    sudo install -m 755 "$REPO_ROOT/build/guest-icd/libvkwebx.so" \
        /tmp/webx-rootfs/usr/local/lib/libvkwebx.so
else
    echo "[webx] WARNING: libvkwebx.so not built yet. Run: npm run build:icd"
    echo "       ICD manifest installed but library missing — Vulkan will fail."
fi

# ICD manifest
sudo mkdir -p /tmp/webx-rootfs/etc/vulkan/icd.d
sudo install -m 644 "$REPO_ROOT/guest-icd/vkwebx_icd.json" \
    /tmp/webx-rootfs/etc/vulkan/icd.d/vkwebx_icd.json

# Remove other ICDs (GPU vendor ICDs won't work in browser context)
sudo rm -f /tmp/webx-rootfs/etc/vulkan/icd.d/intel_*.json \
           /tmp/webx-rootfs/etc/vulkan/icd.d/radeon*.json \
           /tmp/webx-rootfs/etc/vulkan/icd.d/nvidia*.json \
           /tmp/webx-rootfs/etc/vulkan/icd.d/lvp*.json \
           /tmp/webx-rootfs/etc/vulkan/icd.d/dzn*.json 2>/dev/null || true

# WebX launch script
sudo mkdir -p /tmp/webx-rootfs/opt/webx
sudo install -m 755 "$REPO_ROOT/steam/launch.sh" \
    /tmp/webx-rootfs/opt/webx/launch.sh

# Update ld cache for the new library
sudo chroot /tmp/webx-rootfs /sbin/ldconfig 2>/dev/null || true

sudo umount /tmp/webx-rootfs
LOOP=""

# ── 6. Convert ext4 → ext2 ───────────────────────────────────────────
# Canary's VFS parser accepts ext2 images.
echo "[webx] Converting to ext2 for Canary compatibility..."
FINAL="$OUT/steamos-webx.ext2"
cp "$ROOTFS_IMG" "$FINAL"
# Tune down ext4 features to ext2-compatible subset
sudo tune2fs -O ^extent,^flex_bg,^has_journal,^huge_file,^uninit_bg "$FINAL" 2>/dev/null || true
sudo e2fsck -f "$FINAL" || true

echo ""
echo "[webx] ── Done ─────────────────────────────────────────────────────"
echo "  Image: $FINAL"
echo "  Size:  $(($(stat -c%s "$FINAL") / 1024 / 1024)) MB"
echo ""
echo "  Serve at /steam/steamos-webx.ext2 (needs COOP/COEP headers)."
echo "  Update STEAMOS_IMAGE_URL in harness/canary-host.mjs if you move it."
