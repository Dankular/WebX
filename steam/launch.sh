#!/bin/bash
# /opt/webx/launch.sh
# Runs inside the SteamOS CheerpX guest.
# Starts an X server, then launches the target game via Proton.
#
# Environment variables set by cheerpx-host.mjs:
#   VK_DRIVER_FILES    → /etc/vulkan/icd.d/vkwebx_icd.json
#   STEAM_COMPAT_DATA_PATH
#   PROTON_*

set -e

GAME="${WEBX_GAME_EXE:-/games/game.exe}"
PROTON="${PROTON_PATH:-/usr/bin/proton}"

echo "[webx] Starting X server..."
Xorg :0 -noreset &
export DISPLAY=:0
sleep 1

echo "[webx] Vulkan ICD: $VK_DRIVER_FILES"
echo "[webx] GPU device: $(DISPLAY=:0 vulkaninfo --summary 2>/dev/null | grep deviceName || echo unknown)"

echo "[webx] Launching: $GAME"
exec "$PROTON" run "$GAME"
