#!/bin/bash
# /opt/webx/launch.sh
# Runs inside the CheerpX guest (i386 Debian bookworm).
# Starts an X server, initialises Wine + DXVK, then launches the target game.
#
# CheerpX-specific workarounds applied here:
#   1. Remove stale Xorg lock/socket (IDBDevice overlay persists them across sessions)
#   2. Pre-create /tmp/.X11-unix — Xorg can't create it (no setuid-root in CheerpX)
#   3. LIBGL_ALWAYS_SOFTWARE=1 — no Mesa DRI driver for "CheerpX KMS" device
#   4. AccelMethod none in xorg.conf — modesetting driver, CPU 2D, no glamor/DRI
#   5. AutoAddDevices false — udev is not running inside CheerpX

set -e

GAME="${WEBX_GAME_EXE:-/games/game.exe}"
export WINEPREFIX="${WINEPREFIX:-/home/gamer/.wine}"
export WINEARCH=win32
export WINEDEBUG=-all,+d3d,+vulkan

# ── 1. Clean up any stale Xorg state from a previous session ─────────────────
# The IDBDevice read-write overlay persists /tmp across CheerpX restarts.
# Without cleanup, Xorg refuses to start ("Server is already active for display 0").
rm -f  /tmp/.X0-lock         2>/dev/null || true
rm -f  /tmp/.X11-unix/X0     2>/dev/null || true
rm -rf /tmp/.X11-unix         2>/dev/null || true

# ── 2. Pre-create /tmp/.X11-unix with sticky bit ─────────────────────────────
mkdir -p  /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

# ── 3. Force Mesa software rendering ─────────────────────────────────────────
# CheerpX exposes a virtual "CheerpX KMS" DRM device. Mesa looks for a DRI
# driver named "CheerpX KMS_dri.so" which doesn't exist. Force software path.
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=softpipe

# ── 4+5. Minimal Xorg config ─────────────────────────────────────────────────
cat > /tmp/xorg.conf <<'XORGEOF'
Section "ServerFlags"
    Option "AutoAddDevices"    "false"
    Option "AutoEnableDevices" "false"
EndSection

Section "Device"
    Identifier "Device0"
    Driver     "modesetting"
    Option     "AccelMethod" "none"
EndSection

Section "Screen"
    Identifier "Screen0"
    Device     "Device0"
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
    echo "[webx] Initializing Wine prefix (first run)..."
    wine wineboot --init >/tmp/wineboot.log 2>&1 || true
    sleep 2

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
