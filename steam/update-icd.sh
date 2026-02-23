#!/usr/bin/env bash
# update-icd.sh
# Fast ICD-only update — loop-mounts steamos-webx.ext2, installs the new
# libvkwebx.so (and optionally launch.sh), then unmounts.
#
# Use this instead of extract-rootfs.sh when only libvkwebx.so changed.
# extract-rootfs.sh does a full 5 GB dd from the raw disk image (~14 min);
# this script takes ~5 seconds.
#
# Usage (WSL Ubuntu, Z: already mounted at /mnt/z):
#   bash steam/update-icd.sh steam/steamos-webx.ext2
#
# Or from npm scripts (once added to package.json):
#   npm run update:icd

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE="${1:-$REPO_ROOT/steam/steamos-webx.ext2}"
MOUNT=/tmp/webx-update-rootfs

if [ ! -f "$IMAGE" ]; then
    echo "[webx] ERROR: Image not found: $IMAGE"
    echo "       Run extract-rootfs.sh first to produce steamos-webx.ext2."
    exit 1
fi

if [ ! -f "$REPO_ROOT/build/guest-icd/libvkwebx.so" ]; then
    echo "[webx] ERROR: libvkwebx.so not built."
    echo "       Run: cmake --build build/guest-icd"
    exit 1
fi

LOOP=""
cleanup() {
    [ -n "$LOOP" ] && sudo losetup -d "$LOOP" 2>/dev/null || true
    sudo umount "$MOUNT" 2>/dev/null || true
}
trap cleanup EXIT

echo "[webx] Attaching: $IMAGE"
LOOP=$(sudo losetup -f --show "$IMAGE")
echo "[webx] Loop: $LOOP"

sudo mkdir -p "$MOUNT"
sudo mount "$LOOP" "$MOUNT"

echo "[webx] Installing libvkwebx.so..."
sudo install -m 755 "$REPO_ROOT/build/guest-icd/libvkwebx.so" \
    "$MOUNT/usr/local/lib/libvkwebx.so"

echo "[webx] Installing vkwebx_icd.json..."
sudo mkdir -p "$MOUNT/etc/vulkan/icd.d"
sudo install -m 644 "$REPO_ROOT/guest-icd/vkwebx_icd.json" \
    "$MOUNT/etc/vulkan/icd.d/vkwebx_icd.json"

echo "[webx] Installing launch.sh..."
sudo mkdir -p "$MOUNT/opt/webx"
sudo install -m 755 "$REPO_ROOT/steam/launch.sh" \
    "$MOUNT/opt/webx/launch.sh"

sudo chroot "$MOUNT" /sbin/ldconfig 2>/dev/null || true

sudo umount "$MOUNT"
LOOP=""

echo ""
echo "[webx] ── Done ────────────────────────────────────────────────────"
echo "  Updated: $IMAGE"
echo "  libvkwebx.so version: $(strings $REPO_ROOT/build/guest-icd/libvkwebx.so | grep -m1 'webx_' || echo '(unknown)')"
echo ""
echo "  Serve with: npm run dev"
