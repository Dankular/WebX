#!/bin/bash
# /opt/webx/launch.sh
# Runs inside the CheerpX guest (i386 Debian bookworm).
# Starts an X server, initialises Wine + DXVK, then launches the target game.
#
# CheerpX only emulates 32-bit (i386) Linux. Wine32 is used instead of Proton.
# DXVK win32 DLLs are pre-installed at /usr/share/dxvk/ by prepare-image.sh.
#
# Environment variables set by cheerpx-host.mjs:
#   VK_DRIVER_FILES    → /etc/vulkan/icd.d/vkwebgpu_icd.json
#   WEBX_GAME_EXE      → path to the Windows game .exe (default: /games/game.exe)
#   WINEPREFIX         → Wine prefix directory (default: /home/gamer/.wine)

set -e

GAME="${WEBX_GAME_EXE:-/games/game.exe}"
export WINEPREFIX="${WINEPREFIX:-/home/gamer/.wine}"
export WINEARCH=win32
export WINEDEBUG=-all,+d3d,+vulkan

echo "[webx] Starting X server..."
Xorg :0 -noreset -logfile /tmp/Xorg.log &
export DISPLAY=:0
sleep 2

echo "[webx] Vulkan ICD: $VK_DRIVER_FILES"

# Initialise Wine prefix and install DXVK on first boot
if [ ! -f "$WINEPREFIX/.webx_initialized" ]; then
    echo "[webx] Initializing Wine prefix (first run)..."
    wine wineboot --init 2>/dev/null || true
    sleep 1

    echo "[webx] Installing DXVK x32 DLLs..."
    DXVK_DIR=/usr/share/dxvk
    SYS32="$WINEPREFIX/drive_c/windows/system32"
    mkdir -p "$SYS32"
    for dll in d3d9 d3d10 d3d10_1 d3d10core d3d11 dxgi; do
        if [ -f "$DXVK_DIR/${dll}.dll" ]; then
            cp "$DXVK_DIR/${dll}.dll" "$SYS32/${dll}.dll"
            wine reg add "HKCU\\Software\\Wine\\DllOverrides" \
                /v "$dll" /d "native" /f 2>/dev/null || true
        fi
    done

    touch "$WINEPREFIX/.webx_initialized"
    echo "[webx] Wine + DXVK ready."
fi

echo "[webx] Launching: $GAME"
exec wine "$GAME"
