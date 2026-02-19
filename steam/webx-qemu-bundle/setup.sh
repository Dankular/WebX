#!/bin/sh
# Runs inside the Alpine QEMU VM.
# /dev/vda    = SteamOS rootfs (ext4)
# /mnt/bundle = host bundle dir via 9P virtfs

set -e

echo "[webx-vm] Installing e2fsprogs..."
apk add e2fsprogs --quiet 2>&1

echo "[webx-vm] Mounting SteamOS rootfs..."
mount /dev/vda /mnt

echo "[webx-vm] Installing WebX guest ICD..."
install -d /mnt/usr/lib/x86_64-linux-gnu /mnt/etc/vulkan/icd.d /mnt/opt/webx

if [ -f /mnt/bundle/libvkwebgpu.so ]; then
    install -m755 /mnt/bundle/libvkwebgpu.so /mnt/usr/lib/x86_64-linux-gnu/libvkwebgpu.so
    echo "[webx-vm]   Installed libvkwebgpu.so"
else
    echo "[webx-vm]   WARNING: libvkwebgpu.so not in bundle - run steam/build-vkwebgpu.sh first"
fi

[ -f /mnt/bundle/vkwebgpu_icd.json ] && \
    install -m644 /mnt/bundle/vkwebgpu_icd.json /mnt/etc/vulkan/icd.d/vkwebgpu_icd.json
[ -f /mnt/bundle/launch.sh ] && \
    install -m755 /mnt/bundle/launch.sh /mnt/opt/webx/launch.sh

echo "[webx-vm] Removing vendor GPU ICDs..."
rm -f /mnt/etc/vulkan/icd.d/intel*.json \
      /mnt/etc/vulkan/icd.d/radeon*.json \
      /mnt/etc/vulkan/icd.d/nvidia*.json \
      /mnt/etc/vulkan/icd.d/lvp*.json \
      /mnt/etc/vulkan/icd.d/dzn*.json

echo "[webx-vm] Updating ld cache..."
chroot /mnt /sbin/ldconfig 2>/dev/null || true

echo "[webx-vm] Unmounting..."
umount /mnt

echo "[webx-vm] Converting ext4 -> ext2-compatible (tune2fs)..."
e2fsck -fy /dev/vda 2>&1 || true
tune2fs -O ^extent,^flex_bg,^has_journal,^huge_file,^uninit_bg /dev/vda 2>&1 || true
e2fsck -fy /dev/vda 2>&1 || true

echo "[webx-vm] SETUP_DONE"
poweroff
