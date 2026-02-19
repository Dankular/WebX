#!/usr/bin/env bash
# build-vkwebgpu.sh
#
# Cross-compiles VkWebGPU-ICD with the `webx` feature (IPC-to-browser backend)
# for x86_64-unknown-linux-gnu inside a Docker container.
#
# Output: steam/libvkwebgpu.so  (copied here for inclusion in the SteamOS image)
#
# Prerequisites: Docker with access to the VkWebGPU-ICD repository.
#
# Usage (from WebX repo root):
#   bash steam/build-vkwebgpu.sh
#   # Then run prepare-image.sh to bundle it into the SteamOS ext2 image.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ICD_REPO="$(cd "$REPO_ROOT/../VkWebGPU-ICD" && pwd)"

OUTPUT="$SCRIPT_DIR/libvkwebgpu.so"

echo "[webx] Building VkWebGPU-ICD with webx feature..."
echo "       ICD repo : $ICD_REPO"
echo "       Output   : $OUTPUT"

# Use the official Rust slim image for a reproducible build.
# We mount the ICD repo as /icd and cache Cargo registry between runs via a
# named volume so rebuilds don't re-download all dependencies.
docker run --rm \
    -v "$ICD_REPO:/icd:rw" \
    -v vkwebgpu-cargo-cache:/usr/local/cargo/registry \
    rust:1.82-slim \
    bash -c '
        set -euo pipefail
        apt-get update -qq
        apt-get install -yq --no-install-recommends \
            libvulkan-dev \
            pkg-config \
            2>/dev/null
        echo "[docker] Building vkwebgpu crate with webx feature..."
        cd /icd/vkwebgpu
        cargo build --release --features webx 2>&1
        echo "[docker] Build complete."
    '

# Copy the resulting .so into the steam/ staging directory.
SO_PATH="$ICD_REPO/target/release/libvkwebgpu.so"
if [[ -f "$SO_PATH" ]]; then
    cp "$SO_PATH" "$OUTPUT"
    echo "[webx] Copied libvkwebgpu.so to $OUTPUT"
else
    echo "[webx] ERROR: $SO_PATH not found after build" >&2
    exit 1
fi

echo ""
echo "[webx] Done. Run prepare-image.sh to bundle it into the SteamOS image."
