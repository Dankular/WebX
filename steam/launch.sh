#!/bin/bash
# /opt/webx/launch.sh
# Runs inside the Canary guest (x86-64 SteamOS).
# Starts an X server, initialises Proton/Wine + DXVK, then launches the game.
#
# Canary-specific notes:
#   1. Remove stale Xorg lock/socket from previous sessions
#   2. Pre-create /tmp/.X11-unix — Xorg needs it to exist
#   3. Use the fbdev driver against /dev/fb0 (Canary's virtual framebuffer)
#   4. AutoAddDevices false — udev is not running inside Canary

set -e

GAME="${WEBX_GAME_EXE:-/games/game.exe}"
export WINEPREFIX="${WINEPREFIX:-/home/gamer/.wine}"
export WINEARCH="${WINEARCH:-win64}"
export WINEDEBUG="${WINEDEBUG:--all,+d3d,+vulkan}"

# ── 1. Clean up any stale Xorg state from a previous session ─────────────────
rm -f  /tmp/.X0-lock         2>/dev/null || true
rm -f  /tmp/.X11-unix/X0     2>/dev/null || true
rm -rf /tmp/.X11-unix         2>/dev/null || true

# ── 2. Pre-create /tmp/.X11-unix with sticky bit ─────────────────────────────
mkdir -p  /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

# ── 3. Xorg config — fbdev driver against Canary's /dev/fb0 ──────────────────
cat > /tmp/xorg.conf <<'XORGEOF'
Section "ServerFlags"
    Option "AutoAddDevices"    "false"
    Option "AutoEnableDevices" "false"
EndSection

Section "Device"
    Identifier "Device0"
    Driver     "fbdev"
    Option     "fbdev" "/dev/fb0"
EndSection

Section "Screen"
    Identifier "Screen0"
    Device     "Device0"
    DefaultDepth 24
EndSection

Section "ServerLayout"
    Identifier "Layout0"
    Screen     "Screen0"
EndSection
XORGEOF

# ── Start X server ────────────────────────────────────────────────────────────
echo "[webx] Starting X server..."
Xorg :0 -noreset -config /tmp/xorg.conf -logfile /tmp/Xorg.log &
export DISPLAY=:0

# Wait up to 10 s for the Unix socket to appear
for i in $(seq 1 10); do
    [ -S /tmp/.X11-unix/X0 ] && break
    sleep 1
done

if [ ! -S /tmp/.X11-unix/X0 ]; then
    echo "[webx] ERROR: X server did not start — Xorg log:"
    cat /tmp/Xorg.log 2>/dev/null || echo "(no log)"
    exit 1
fi
echo "[webx] X server ready"

echo "[webx] Vulkan ICD: $VK_DRIVER_FILES"

# ── Wine prefix initialisation (first run only) ───────────────────────────────
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
