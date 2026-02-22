#!/usr/bin/env bash
# prepare-image.sh
#
# Builds ONE ext2 image for CheerpX (must be < 2 GB — HttpBytesDevice limit):
#
#   steamos-rootfs.ext2  (~1.4 GB)  — i386 Debian + Wine32 + DXVK + VkWebGPU ICD
#
# CheerpX only supports 32-bit (i386) Linux ELF binaries.
# Base: i386/debian:bookworm — provides Wine 8.0, native 32-bit toolchain.
# DXVK 2.x (win32 DLLs) is installed for D3D9/10/11 → Vulkan translation.
# The libvkwebgpu.so must be compiled for i686:
#   cargo build --target i686-unknown-linux-gnu --release --features webx
#
# Requires: docker (with QEMU/binfmt multiarch enabled), mkfs.ext2, losetup
# Output:   steam/steamos-rootfs.ext2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE_TAG="webx-i386:latest"
OUTPUT_ROOT="$SCRIPT_DIR/steamos-rootfs.ext2"
MOUNT_DIR="$(mktemp -d)"

cleanup() { sudo umount /mnt 2>/dev/null || true; sudo losetup -D 2>/dev/null || true; rm -rf "$MOUNT_DIR"; }
trap cleanup EXIT

# ── Step 1: Build Docker image ────────────────────────────────────────
cat > "$SCRIPT_DIR/Dockerfile.steamos" <<'DOCKERFILE'
FROM i386/debian:bookworm

# Minimal packages: Wine 8.0 + Xorg + Vulkan loader + curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    wine \
    xserver-xorg-core \
    xserver-xorg-video-fbdev \
    xserver-xorg-video-modesetting \
    xserver-xorg-input-libinput \
    libvulkan1 \
    vulkan-tools \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# DXVK 2.x win32 DLLs (requires Wine 7.1+ — bookworm has Wine 8.0)
# Provides d3d9/d3d10/d3d11/dxgi → Vulkan translation for DirectX games
ARG DXVK_VER=2.4
RUN curl -fL \
    "https://github.com/doitsujin/dxvk/releases/download/v${DXVK_VER}/dxvk-${DXVK_VER}.tar.gz" \
    | tar -C /tmp -xz \
    && mkdir -p /usr/share/dxvk \
    && cp /tmp/dxvk-${DXVK_VER}/x32/*.dll /usr/share/dxvk/ \
    && rm -rf /tmp/dxvk-${DXVK_VER}

# VkWebGPU ICD — must be i386 ELF (cross-compile with i686-unknown-linux-gnu target)
COPY libvkwebgpu.so /usr/lib/i386-linux-gnu/libvkwebgpu.so
COPY vkwebgpu_icd.json /etc/vulkan/icd.d/vkwebgpu_icd.json

# Remove any pre-installed GPU ICDs that might conflict with ours
RUN rm -f /etc/vulkan/icd.d/intel*.json \
          /etc/vulkan/icd.d/radeon*.json \
          /etc/vulkan/icd.d/nvidia*.json \
          /etc/vulkan/icd.d/lvp*.json

# WebX boot script
COPY launch.sh /opt/webx/launch.sh
RUN chmod +x /opt/webx/launch.sh

# Default user for Wine prefix
RUN useradd -m -u 1000 gamer
DOCKERFILE

echo "[webx] Building i386 container image (i386/debian:bookworm + Wine 8 + DXVK 2.x)..."

if [[ ! -f "$SCRIPT_DIR/libvkwebgpu.so" ]]; then
    echo "[webx] WARNING: steam/libvkwebgpu.so not found — using stub (ICD will not load)."
    printf '\x7fELF' > "$SCRIPT_DIR/libvkwebgpu.so"
fi

# --platform linux/386: required on amd64 host to pull the i386 base image variant
docker build --platform linux/386 \
    -f "$SCRIPT_DIR/Dockerfile.steamos" \
    -t "$IMAGE_TAG" \
    "$SCRIPT_DIR"

# ── Step 2: Export container filesystem ───────────────────────────────
echo "[webx] Exporting container filesystem..."
CONTAINER_ID=$(docker create --platform linux/386 "$IMAGE_TAG")
docker export "$CONTAINER_ID" | tar -C "$MOUNT_DIR" -x
docker rm "$CONTAINER_ID"

# ── Step 3: steamos-rootfs.ext2 (~1.5 GB) ─────────────────────────────
# i386 Debian + Wine: ~900 MB data; 1536 MB ext2 leaves comfortable headroom
echo "[webx] Creating steamos-rootfs.ext2 (~1.5 GB)..."
dd if=/dev/zero bs=1M count=1536 of="$OUTPUT_ROOT" status=progress
mkfs.ext2 -F -L "webx-root" "$OUTPUT_ROOT"

LOOP_ROOT=$(sudo losetup -fP --show "$OUTPUT_ROOT")
sudo mount "$LOOP_ROOT" /mnt
sudo cp -a "$MOUNT_DIR/." /mnt/ 2>/dev/null || true
sudo umount /mnt
sudo losetup -d "$LOOP_ROOT"
echo "[webx] steamos-rootfs.ext2 done."

echo ""
echo "[webx] ── Done ──────────────────────────────────────────────────"
echo "  Image: $OUTPUT_ROOT  (~$(du -sh "$OUTPUT_ROOT" | cut -f1))"
echo ""
echo "  Single image (< 2 GB) — compatible with CheerpX HttpBytesDevice."
echo "  Serve with COOP/COEP headers via: node harness/server.mjs"
echo "  cheerpx-host.mjs mounts / from steamos-rootfs.ext2"
