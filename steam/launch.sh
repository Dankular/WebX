#!/bin/bash
# /opt/webx/launch.sh
# Runs inside the Canary guest (x86-64 SteamOS).
# Starts Proton/Wine + DXVK without requiring a real X server.
#
# X11 Surface Strategy:
#   libxcb_stub.so (LD_PRELOAD) intercepts all xcb_* calls and returns
#   fake handles.  DXVK/Wine believe they have an X11 connection and window;
#   the vkwebx ICD ignores the xcb pointers and routes Vulkan frames to
#   WebGPU over the x86 I/O port 0x7860 bridge.
#
# Canary-specific notes:
#   1. No Xorg — fbdev driver is not needed (WebGPU replaces the display path)
#   2. SYS_FORK returns -EPERM; wineserver starts via CLONE_VM thread instead
#   3. AF_UNIX sockets are emulated in-memory by Canary (no real kernel sockets)

set -e

GAME="${WEBX_GAME_EXE:-/games/game.exe}"
export WINEPREFIX="${WINEPREFIX:-/home/gamer/.wine}"
export WINEARCH="${WINEARCH:-win64}"
export WINEDEBUG="${WINEDEBUG:--all,+d3d,+vulkan}"

# ── Fake display: set DISPLAY but rely on xcb stub for the connection ─────
export DISPLAY=:0

# ── LD_PRELOAD libxcb_stub.so before any Wine/DXVK code loads xcb ─────────
XCBSTUB=/usr/local/lib/libxcb_stub.so
if [ -f "$XCBSTUB" ]; then
    export LD_PRELOAD="${LD_PRELOAD:+$LD_PRELOAD:}$XCBSTUB"
    echo "[webx] xcb stub loaded: $XCBSTUB"
else
    echo "[webx] WARNING: xcb stub not found at $XCBSTUB — X11 connection will fail"
fi

# ── Create /tmp/.X11-unix so Wine/xcb don't abort on missing directory ────
mkdir -p  /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
# Create a dummy socket placeholder so Wine's socket-existence checks pass.
# The xcb stub intercepts xcb_connect() before it opens the socket, so
# we just need the path to exist as a regular file.
touch /tmp/.X11-unix/X0 2>/dev/null || true

echo "[webx] Vulkan ICD: $VK_DRIVER_FILES"

# ── Wine prefix initialisation (first run only) ───────────────────────────
if [ ! -f "$WINEPREFIX/.webx_initialized" ]; then
    echo "[webx] Initializing Wine prefix (first run, WINEARCH=$WINEARCH)..."
    wine wineboot --init >/tmp/wineboot.log 2>&1 || true
    sleep 2

    echo "[webx] Installing DXVK DLLs..."
    DXVK_DIR=/usr/share/dxvk
    # x86-64 prefix: system32 holds 64-bit DLLs, syswow64 holds 32-bit
    SYS64="$WINEPREFIX/drive_c/windows/system32"
    SYS32="$WINEPREFIX/drive_c/windows/syswow64"
    mkdir -p "$SYS64" "$SYS32"

    for dll in d3d9 d3d10 d3d10_1 d3d10core d3d11 dxgi; do
        # 64-bit
        if [ -f "$DXVK_DIR/x64/${dll}.dll" ]; then
            cp "$DXVK_DIR/x64/${dll}.dll" "$SYS64/${dll}.dll"
            wine reg add "HKCU\\Software\\Wine\\DllOverrides" \
                /v "$dll" /d "native" /f 2>/dev/null || true
        fi
        # 32-bit (for 32-bit game components)
        if [ -f "$DXVK_DIR/x32/${dll}.dll" ]; then
            cp "$DXVK_DIR/x32/${dll}.dll" "$SYS32/${dll}.dll"
        fi
    done

    touch "$WINEPREFIX/.webx_initialized"
    echo "[webx] Wine + DXVK ready."
fi

echo "[webx] Launching: $GAME"
exec wine "$GAME"
