#!/bin/bash
# /opt/webx/launch.sh - runs inside Canary guest (x86-64 SteamOS)
#
# Modes (WEBX_MODE env var):
#   desktop  — Boot SteamOS game mode: gamescope -> Steam Big Picture (default)
#   game     — Launch specific game via GE-Proton (set WEBX_GAME_EXE)

set -e

export HOME=${HOME:-/home/gamer}
export USER=${USER:-gamer}
export DISPLAY=:0
export XDG_RUNTIME_DIR=/run/user/1000

# Route all Vulkan through our WebX ICD
export VK_DRIVER_FILES=/etc/vulkan/icd.d/vkwebx_icd.json
export VK_ICD_FILENAMES=/etc/vulkan/icd.d/vkwebx_icd.json

# DXVK / VKD3D settings
export DXVK_LOG_LEVEL=warn
export DXVK_HUD=fps,devinfo
export WINEDEBUG=${WINEDEBUG:--all,+d3d,+vulkan}

# XCB stub - intercepts X11 connection attempts so Wine/DXVK work without Xorg
XCBSTUB=/usr/local/lib/libxcb_stub.so
if [ -f "$XCBSTUB" ]; then
    export LD_PRELOAD="${LD_PRELOAD:+$LD_PRELOAD:}$XCBSTUB"
    echo "[webx] xcb stub loaded"
else
    echo "[webx] WARNING: xcb stub not found at $XCBSTUB"
fi

# Basic tmpfs layout expected by Wine and gamescope
mkdir -p /tmp/.X11-unix "$XDG_RUNTIME_DIR"
chmod 1777 /tmp/.X11-unix
chmod 700 "$XDG_RUNTIME_DIR"
touch /tmp/.X11-unix/X0 2>/dev/null || true

# Create gamer user if missing (first boot)
if ! id gamer &>/dev/null 2>&1; then
    useradd -m -s /bin/bash gamer 2>/dev/null || true
fi
mkdir -p "$HOME"

echo "[webx] Vulkan ICD: $VK_DRIVER_FILES"
echo "[webx] Mode: ${WEBX_MODE:-desktop}"

# ── Desktop mode (default): gamescope -> Steam Big Picture ────────────────
if [ "${WEBX_MODE:-desktop}" = "desktop" ]; then
    echo "[webx] Booting SteamOS game mode (gamescope + Steam)..."
    # --backend headless: gamescope renders via Vulkan with no physical display.
    # Our libvkwebx.so ICD intercepts all Vulkan calls and routes frames to
    # the browser over x86 I/O port 0x7860 -> VkBridge -> WebGPU.
    exec gamescope \
        -W 1280 -H 800 \
        -r 60 \
        --backend headless \
        --steam \
        -- steam \
            -gamepadui \
            -steamdeck \
            -steamos \
            -noverifyfiles \
            -nointro \
            -novid
fi

# ── Game mode: launch specific game directly via GE-Proton ────────────────
GAME="${WEBX_GAME_EXE:-/games/The Sims 4/Game/Bin/TS4_x64.exe}"
echo "[webx] Game mode - launching: $GAME"

# Locate GE-Proton
PROTON_DIR=""
for d in /root/.steam/root/compatibilitytools.d/GE-Proton* \
          /home/gamer/.steam/root/compatibilitytools.d/GE-Proton*; do
    [ -d "$d" ] && PROTON_DIR="$d" && break
done

if [ -z "$PROTON_DIR" ]; then
    echo "[webx] ERROR: No GE-Proton found. Boot in desktop mode first to install via Steam."
    exit 1
fi

echo "[webx] Using Proton: $PROTON_DIR"
export STEAM_COMPAT_DATA_PATH="${STEAM_COMPAT_DATA_PATH:-$HOME/.proton-compat}"
export STEAM_COMPAT_CLIENT_INSTALL_PATH=/root/.steam/root
export WINEPREFIX="${WINEPREFIX:-$HOME/.wine}"
export WINEARCH=win64
mkdir -p "$STEAM_COMPAT_DATA_PATH"

exec "$PROTON_DIR/proton" run "$GAME"
