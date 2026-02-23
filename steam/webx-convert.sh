#!/bin/bash
set -euo pipefail

BTRFS=/tmp/webx-btrfs-rootfs
EXT2_MOUNT=/tmp/webx-ext2-rootfs
FINAL=/mnt/z/Repos/WebSteamOS/WebX/steam/steamos-webx.ext2
WEBX=/mnt/z/Repos/WebSteamOS/WebX

umount $EXT2_MOUNT 2>/dev/null || true
rm -f "$FINAL"

mountpoint -q $BTRFS || mount -t btrfs -o loop,ro /mnt/z/Repos/WebSteamOS/WebX/steam/steamos-rootfs.img $BTRFS

echo "[webx] Creating 7000 MB ext2 image..."
dd if=/dev/zero of="$FINAL" bs=1M count=7000 status=progress

echo "[webx] Formatting as ext2..."
mkfs.ext2 -L rootfs -m 1 "$FINAL"

echo "[webx] Mounting ext2..."
mkdir -p $EXT2_MOUNT
mount -o loop "$FINAL" $EXT2_MOUNT

echo "[webx] Rsyncing btrfs -> ext2..."
rsync -aH --info=progress2 $BTRFS/ $EXT2_MOUNT/
echo "[webx] rsync done."

echo "[webx] Installing libvkwebx.so..."
install -m 755 $WEBX/build/guest-icd/libvkwebx.so $EXT2_MOUNT/usr/local/lib/libvkwebx.so

echo "[webx] Installing vkwebx_icd.json..."
mkdir -p $EXT2_MOUNT/etc/vulkan/icd.d
install -m 644 $WEBX/guest-icd/vkwebx_icd.json $EXT2_MOUNT/etc/vulkan/icd.d/vkwebx_icd.json

echo "[webx] Removing competing ICDs..."
rm -f $EXT2_MOUNT/etc/vulkan/icd.d/intel_*.json \
      $EXT2_MOUNT/etc/vulkan/icd.d/radeon*.json \
      $EXT2_MOUNT/etc/vulkan/icd.d/nvidia*.json \
      $EXT2_MOUNT/etc/vulkan/icd.d/lvp*.json \
      $EXT2_MOUNT/etc/vulkan/icd.d/dzn*.json 2>/dev/null || true

echo "[webx] Installing launch.sh..."
mkdir -p $EXT2_MOUNT/opt/webx
install -m 755 $WEBX/steam/launch.sh $EXT2_MOUNT/opt/webx/launch.sh

echo "[webx] Running ldconfig..."
chroot $EXT2_MOUNT /sbin/ldconfig 2>/dev/null || true

echo "[webx] Unmounting..."
umount $EXT2_MOUNT
umount $BTRFS

echo ""
echo "[webx] Done!"
SIZE=$(stat -c%s "$FINAL")
echo "  Image: $FINAL"
echo "  Size: $((SIZE / 1024 / 1024)) MB"
