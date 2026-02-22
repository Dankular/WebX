#!/usr/bin/env bash
# prepare-image.sh
#
# Builds two ext2 images for CheerpX (each must be < 2 GB due to HttpBytesDevice limit):
#
#   steamos-rootfs.ext2  (~1.2 GB)  — Sniper base + Xorg + VkWebGPU ICD + boot scripts
#   steamos-proton.ext2  (~1.8 GB)  — GE-Proton only, mounted at /opt inside CheerpX
#
# cheerpx-host.mjs mounts:
#   /     ← steamos-rootfs.ext2
#   /opt  ← steamos-proton.ext2
#
# Requires: docker, curl (in container)
# Output:   steam/steamos-rootfs.ext2   steam/steamos-proton.ext2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE_TAG="webx-steamos:latest"
OUTPUT_ROOT="$SCRIPT_DIR/steamos-rootfs.ext2"
OUTPUT_PROTON="$SCRIPT_DIR/steamos-proton.ext2"
MOUNT_DIR="$(mktemp -d)"

cleanup() { rm -rf "$MOUNT_DIR"; }
trap cleanup EXIT

# ── Step 1: Build Docker image ────────────────────────────────────────
cat > "$SCRIPT_DIR/Dockerfile.steamos" <<'EOF'
FROM registry.gitlab.steamos.cloud/steamrt/sniper/platform:latest

# libvulkan1, curl, python3 already in Sniper base; i386 already enabled.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xserver-xorg-core \
    xserver-xorg-video-fbdev \
    xserver-xorg-video-modesetting \
    xserver-xorg-input-libinput \
    && rm -rf /var/lib/apt/lists/*

# Download GE-Proton into /opt (Wine + DXVK + VKD3D-Proton + FAudio)
ARG PROTON_VER=GE-Proton10-32
RUN mkdir -p /opt && curl -L \
    "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/${PROTON_VER}/${PROTON_VER}.tar.gz" \
    | tar -C /opt -xz \
    && ln -sf /opt/${PROTON_VER}/proton /usr/bin/proton

# WebX boot script
COPY launch.sh /opt/webx/launch.sh
RUN chmod +x /opt/webx/launch.sh

# VkWebGPU ICD
COPY libvkwebgpu.so /usr/lib/x86_64-linux-gnu/libvkwebgpu.so
COPY vkwebgpu_icd.json /etc/vulkan/icd.d/vkwebgpu_icd.json

# Remove GPU vendor ICDs
RUN rm -f /etc/vulkan/icd.d/intel*.json \
          /etc/vulkan/icd.d/radeon*.json \
          /etc/vulkan/icd.d/nvidia*.json \
          /etc/vulkan/icd.d/lvp*.json \
          /etc/vulkan/icd.d/vkwebx*.json

# Default user
RUN useradd -m -u 1000 gamer
EOF

echo "[webx] Building container image..."

if [[ ! -f "$SCRIPT_DIR/libvkwebgpu.so" ]]; then
    echo "[webx] WARNING: steam/libvkwebgpu.so not found — using stub."
    printf '\x7fELF' > "$SCRIPT_DIR/libvkwebgpu.so"
fi

docker build -f "$SCRIPT_DIR/Dockerfile.steamos" -t "$IMAGE_TAG" "$SCRIPT_DIR"

# ── Step 2: Export container filesystem ───────────────────────────────
echo "[webx] Exporting container filesystem..."
CONTAINER_ID=$(docker create "$IMAGE_TAG")
docker export "$CONTAINER_ID" | tar -C "$MOUNT_DIR" -x
docker rm "$CONTAINER_ID"

# ── Step 3: steamos-rootfs.ext2  (everything except /opt) ────────────
# Data: ~918 MB → 1.3 GB ext2 gives comfortable headroom
echo "[webx] Creating steamos-rootfs.ext2 (~1.3 GB)..."
dd if=/dev/zero bs=1M count=1330 of="$OUTPUT_ROOT" status=progress
mkfs.ext2 -F -L "steamos-root" "$OUTPUT_ROOT"

LOOP_ROOT=$(losetup -fP --show "$OUTPUT_ROOT")
mount "$LOOP_ROOT" /mnt
# Copy everything except /opt (Proton lives in the second image)
cp -a "$MOUNT_DIR/." /mnt/ 2>/dev/null || true
rm -rf /mnt/opt
mkdir -p /mnt/opt   # empty mountpoint — CheerpX will overlay proton image here
umount /mnt
losetup -d "$LOOP_ROOT"
echo "[webx] steamos-rootfs.ext2 done."

# ── Step 4: steamos-proton.ext2  (GE-Proton only, root = /opt contents) ──
# CheerpX mounts this at /opt, so the image root = the /opt directory contents.
# Data: ~1.4 GB → 1.8 GB ext2 (still under the 2 GB HttpBytesDevice limit)
echo "[webx] Creating steamos-proton.ext2 (~1.8 GB)..."
dd if=/dev/zero bs=1M count=1843 of="$OUTPUT_PROTON" status=progress
mkfs.ext2 -F -L "steamos-proton" "$OUTPUT_PROTON"

LOOP_PROTON=$(losetup -fP --show "$OUTPUT_PROTON")
mount "$LOOP_PROTON" /mnt
# /opt in the container holds webx/ and GE-Proton10-32/
cp -a "$MOUNT_DIR/opt/." /mnt/ 2>/dev/null || true
umount /mnt
losetup -d "$LOOP_PROTON"
echo "[webx] steamos-proton.ext2 done."

echo ""
echo "[webx] ── Done ──────────────────────────────────────────────────"
echo "  Root image:   $OUTPUT_ROOT  (~$(du -sh "$OUTPUT_ROOT" | cut -f1))"
echo "  Proton image: $OUTPUT_PROTON  (~$(du -sh "$OUTPUT_PROTON" | cut -f1))"
echo ""
echo "  Both < 2 GB — compatible with CheerpX HttpBytesDevice limit."
echo "  cheerpx-host.mjs mounts / from rootfs and /opt from proton."
echo "  Serve both with COOP/COEP headers via: node harness/server.mjs"
