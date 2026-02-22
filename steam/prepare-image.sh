#!/usr/bin/env bash
# prepare-image.sh
#
# Downloads a SteamOS container base image, installs Proton, and adds the
# WebX guest ICD so the image is ready to be served to CheerpX.
#
# Requires: docker (or podman), e2tools, curl
# Output: steamos-webx.ext2  (serve at /images/steamos-webx.ext2)
#
# The produced image is ~4 GB before compression.  Use HttpBytesDevice
# in CheerpX so only the blocks needed for boot are fetched on demand.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE_TAG="webx-steamos:latest"
OUTPUT="$SCRIPT_DIR/steamos-webx.ext2"
MOUNT_DIR="$(mktemp -d)"

# ── Step 1: Build a SteamOS-compatible container ──────────────────────
# We base on the Steam Runtime Sniper image (the same runtime Proton ships with)
# to get all required base libraries.
cat > "$SCRIPT_DIR/Dockerfile.steamos" <<'EOF'
FROM registry.gitlab.steamos.cloud/steamrt/sniper/platform:latest

# libvulkan1, curl, python3 are already in the Sniper base image.
# i386 is already enabled. Install minimal X server only.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xserver-xorg-core \
    xserver-xorg-video-fbdev \
    xserver-xorg-video-modesetting \
    xserver-xorg-input-libinput \
    && rm -rf /var/lib/apt/lists/*

# Download GE-Proton (includes Wine, DXVK, VKD3D-Proton, FAudio)
ARG PROTON_VER=GE-Proton10-32
RUN mkdir -p /opt && curl -L \
    "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/${PROTON_VER}/${PROTON_VER}.tar.gz" \
    | tar -C /opt -xz \
    && ln -sf /opt/${PROTON_VER}/proton /usr/bin/proton

# WebX boot script
COPY launch.sh /opt/webx/launch.sh
RUN chmod +x /opt/webx/launch.sh

# VkWebGPU ICD binary (Rust, built with webx feature — see steam/build-vkwebgpu.sh)
COPY libvkwebgpu.so /usr/lib/x86_64-linux-gnu/libvkwebgpu.so
COPY vkwebgpu_icd.json /etc/vulkan/icd.d/vkwebgpu_icd.json

# Remove other ICDs so the Vulkan loader only finds our ICD
RUN rm -f /etc/vulkan/icd.d/intel*.json \
          /etc/vulkan/icd.d/radeon*.json \
          /etc/vulkan/icd.d/nvidia*.json \
          /etc/vulkan/icd.d/lvp*.json \
          /etc/vulkan/icd.d/vkwebx*.json

# Default user
RUN useradd -m -u 1000 gamer
EOF

# ── Step 2: Build the Docker image ────────────────────────────────────
echo "[webx] Building SteamOS container image..."

# Copy artifacts needed for the build.
# vkwebgpu_icd.json is already in steam/ (created alongside this script).
# libvkwebgpu.so must be built first: run `npm run build:vkwebgpu:linux`
if [[ ! -f "$SCRIPT_DIR/libvkwebgpu.so" ]]; then
    echo "[webx] WARNING: steam/libvkwebgpu.so not found."
    echo "         Build it first with: npm run build:vkwebgpu:linux"
    echo "         Creating placeholder stub so the image build doesn't fail."
    # Minimal valid ELF stub; replace with the real binary before serving
    printf '\x7fELF' > "$SCRIPT_DIR/libvkwebgpu.so"
fi

docker build \
    -f "$SCRIPT_DIR/Dockerfile.steamos" \
    -t "$IMAGE_TAG" \
    "$SCRIPT_DIR"

# ── Step 3: Export container filesystem to ext2 ───────────────────────
echo "[webx] Exporting container filesystem..."
CONTAINER_ID=$(docker create "$IMAGE_TAG")
docker export "$CONTAINER_ID" | tar -C "$MOUNT_DIR" -x
docker rm "$CONTAINER_ID"

# ── Step 4: Create ext2 image ─────────────────────────────────────────
echo "[webx] Creating ext2 image (this may take a few minutes)..."
# Size: 12 GB — Sniper base + GE-Proton is ~6 GB uncompressed
dd if=/dev/zero bs=1M count=12288 of="$OUTPUT" status=progress
mkfs.ext2 -F -L "steamos-webx" "$OUTPUT"

# Copy filesystem into ext2
# Requires e2tools package: apt install e2tools
# Alternative: use a loop device mount if running as root
if command -v e2cp &>/dev/null; then
    tar -C "$MOUNT_DIR" -c . | e2import - "$OUTPUT"
else
    echo "[webx] e2tools not found — mounting ext2 via loop device (requires root)"
    LOOP=$(sudo losetup -fP --show "$OUTPUT")
    sudo mount "$LOOP" /mnt
    sudo cp -a "$MOUNT_DIR/." /mnt/
    sudo umount /mnt
    sudo losetup -d "$LOOP"
fi

rm -rf "$MOUNT_DIR"
# Note: leave libvkwebgpu.so in steam/ — it is a build artifact, not a temp file.

echo ""
echo "[webx] Done: $OUTPUT"
echo "       Serve at /images/steamos-webx.ext2 with correct COOP/COEP headers."
echo "       For CheerpX HttpBytesDevice, also generate a block index:"
echo "         cheerpx-create-index $OUTPUT > steamos-webx.ext2.js"
