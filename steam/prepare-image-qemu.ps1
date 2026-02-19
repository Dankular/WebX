# prepare-image-qemu.ps1
#
# Prepares a CheerpX-ready SteamOS ext2 image on Windows using QEMU.
# Replaces the WSL2 / Docker requirement from extract-image.ps1.
#
# Prerequisites:
#   QEMU  - C:\Program Files\qemu\  (winget install SoftwareFreedomConservancy.QEMU)
#   Python 3 in PATH (for extract-image.py partition extraction)
#   steamdeck-repair-*.img.bz2 in %USERPROFILE%\Downloads\
#
# What it does:
#   1.  Decompresses + extracts the SteamOS rootfs partition  (Python, pure Windows)
#   2.  Downloads Alpine Linux virt ISO (~60 MB, once) if not present
#   3.  Boots Alpine in QEMU with the SteamOS image as a virtio disk
#       and the WebX ICD files shared via 9P/virtfs
#   4.  Automates the Alpine session (serial console) to:
#         - apk add e2fsprogs
#         - install WebX guest ICD into the rootfs
#         - remove vendor GPU ICDs
#         - tune2fs: strip ext4-only features -> CheerpX-compatible ext2
#         - e2fsck
#         - poweroff
#   5.  Copies result to steamos-webx.ext2
#
# Output: steam\steamos-webx.ext2   (~5-7 GB, serve with COOP/COEP headers)

param(
    [string]$Source    = "$env:USERPROFILE\Downloads\steamdeck-repair-20250521.10-3.7.7.img.bz2",
    [string]$OutDir    = $PSScriptRoot,
    [string]$QemuDir   = "C:\Program Files\qemu",
    [string]$AlpineIso = ""    # auto-download if empty
)

$ErrorActionPreference = "Stop"

$QEMU     = Join-Path $QemuDir "qemu-system-x86_64.exe"
$QEMU_IMG = Join-Path $QemuDir "qemu-img.exe"

foreach ($exe in $QEMU, $QEMU_IMG) {
    if (-not (Test-Path $exe)) {
        Write-Error "QEMU binary not found: $exe`nInstall QEMU: winget install SoftwareFreedomConservancy.QEMU"
    }
}

# --- Step 1: Extract rootfs partition using Python ----------------------------
Write-Host ""
Write-Host "[webx] === Step 1: Extracting SteamOS rootfs (Python) ===" -ForegroundColor Cyan

$rootfsImg = Join-Path $OutDir "steamos-rootfs.img"

if (Test-Path $rootfsImg) {
    $sizeMB = [math]::Round((Get-Item $rootfsImg).Length / 1MB, 0)
    Write-Host "[webx] Rootfs already exists ($sizeMB MB), skipping extraction." -ForegroundColor Yellow
} else {
    $extractPy = Join-Path $PSScriptRoot "extract-image.py"
    if (-not (Test-Path $extractPy)) { Write-Error "Not found: $extractPy" }

    # Check if steamdeck-repair.img already exists to skip bz2 decompression
    $repairImg = Join-Path $OutDir "steamdeck-repair.img"
    if (Test-Path $repairImg) {
        & python $extractPy --source $Source --outdir $OutDir --skip-decompress
    } else {
        & python $extractPy --source $Source --outdir $OutDir
    }
    if ($LASTEXITCODE -ne 0) { Write-Error "extract-image.py failed (exit $LASTEXITCODE)" }

    if (-not (Test-Path $rootfsImg)) { Write-Error "Expected rootfs image not found: $rootfsImg" }

    $sizeMB = [math]::Round((Get-Item $rootfsImg).Length / 1MB, 0)
    Write-Host "[webx] Rootfs image: $rootfsImg  ($sizeMB MB)"
}

# --- Step 2: Alpine Linux ISO -------------------------------------------------
Write-Host ""
Write-Host "[webx] === Step 2: Alpine Linux ISO ===" -ForegroundColor Cyan

if (-not $AlpineIso) { $AlpineIso = Join-Path $OutDir "alpine-virt.iso" }
if (-not (Test-Path $AlpineIso)) {
    $url = "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-virt-3.21.0-x86_64.iso"
    Write-Host "[webx] Downloading Alpine Linux 3.21 virt ISO from:"
    Write-Host "       $url"
    Invoke-WebRequest -Uri $url -OutFile $AlpineIso -UseBasicParsing
    Write-Host "[webx] Downloaded: $AlpineIso"
} else {
    Write-Host "[webx] Using existing: $AlpineIso"
}

# --- Step 3: Prepare ICD bundle directory (shared via 9P into Alpine) --------
Write-Host ""
Write-Host "[webx] === Step 3: Preparing ICD bundle ===" -ForegroundColor Cyan

# QEMU vvfat driver requires a LOCAL path with no spaces (no UNC, no network shares).
# Use %TEMP% which is always local (e.g. C:\Users\Dan\AppData\Local\Temp).
$bundleDir = "$env:TEMP\webx-qemu-bundle"
New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null
Write-Host "[webx]   Local bundle dir: $bundleDir"

# Locate build artifacts.
# libvkwebgpu.so is produced by steam/build-vkwebgpu.sh (Docker cross-compile).
# vkwebgpu_icd.json lives next to this script; it points to
# /usr/lib/x86_64-linux-gnu/libvkwebgpu.so inside the SteamOS rootfs.
$libIcd   = Join-Path $PSScriptRoot "libvkwebgpu.so"
$icdJson  = Join-Path $PSScriptRoot "vkwebgpu_icd.json"
$launchSh = Join-Path $PSScriptRoot "launch.sh"

foreach ($pair in @(
    @{ Src = $libIcd;   Dst = "libvkwebgpu.so"    },
    @{ Src = $icdJson;  Dst = "vkwebgpu_icd.json"  },
    @{ Src = $launchSh; Dst = "launch.sh"           }
)) {
    if (Test-Path $pair.Src) {
        Copy-Item $pair.Src (Join-Path $bundleDir $pair.Dst) -Force
        Write-Host "[webx]   Bundled: $($pair.Dst)"
    } else {
        Write-Warning "[webx]   Missing: $($pair.Src) - continuing without it"
    }
}

# Write the Alpine setup script into the bundle
$setupSh = @'
#!/bin/sh
# Runs inside the Alpine QEMU VM.
# /dev/vda = SteamOS rootfs (btrfs, read-only source)
# /dev/vdb = bundle vvfat disk  (/dev/vdb1 = FAT partition)
# /dev/vdc = new ext4 output disk (written back to host)

set -e

echo "[webx-vm] Installing tools..."
apk add e2fsprogs --quiet 2>&1

echo "[webx-vm] Loading btrfs module (if not built-in)..."
modprobe btrfs 2>&1 || true

echo "[webx-vm] Mounting SteamOS btrfs rootfs read-only..."
mkdir -p /steamos
if ! mount -t btrfs -o ro /dev/vda /steamos 2>&1; then
    echo "[webx-vm] btrfs mount failed, trying usebackuproot..."
    if ! mount -t btrfs -o ro,usebackuproot /dev/vda /steamos 2>&1; then
        echo "[webx-vm] ERROR: cannot mount btrfs. dmesg:"
        dmesg | grep -i btrfs | tail -20
        dmesg | tail -30
        echo "[webx-vm] MOUNT_FAILED"
        poweroff
    fi
fi
echo "[webx-vm] Mounted btrfs at /steamos"

echo "[webx-vm] Creating ext4 filesystem on /dev/vdc..."
mkfs.ext4 -F -L rootfs /dev/vdc
mkdir -p /newroot
mount /dev/vdc /newroot

echo "[webx-vm] Copying SteamOS files to new ext4 (this takes several minutes)..."
cp -a /steamos/. /newroot/

echo "[webx-vm] Installing WebX guest ICD..."
install -d /newroot/usr/lib/x86_64-linux-gnu /newroot/etc/vulkan/icd.d /newroot/opt/webx

if [ -f /bundle/libvkwebgpu.so ]; then
    install -m755 /bundle/libvkwebgpu.so /newroot/usr/lib/x86_64-linux-gnu/libvkwebgpu.so
    echo "[webx-vm]   Installed libvkwebgpu.so"
else
    echo "[webx-vm]   WARNING: libvkwebgpu.so not in bundle - run steam/build-vkwebgpu.sh first"
fi

[ -f /bundle/vkwebgpu_icd.json ] && \
    install -m644 /bundle/vkwebgpu_icd.json /newroot/etc/vulkan/icd.d/vkwebgpu_icd.json
[ -f /bundle/launch.sh ] && \
    install -m755 /bundle/launch.sh /newroot/opt/webx/launch.sh

echo "[webx-vm] Removing vendor GPU ICDs..."
rm -f /newroot/etc/vulkan/icd.d/intel*.json \
      /newroot/etc/vulkan/icd.d/radeon*.json \
      /newroot/etc/vulkan/icd.d/nvidia*.json \
      /newroot/etc/vulkan/icd.d/lvp*.json \
      /newroot/etc/vulkan/icd.d/dzn*.json

echo "[webx-vm] Updating ld cache..."
chroot /newroot /sbin/ldconfig 2>/dev/null || true

echo "[webx-vm] Unmounting..."
umount /steamos
umount /newroot

echo "[webx-vm] Converting ext4 -> ext2-compatible (tune2fs)..."
e2fsck -fy /dev/vdc 2>&1 || true
tune2fs -O ^extent,^flex_bg,^has_journal,^huge_file,^uninit_bg /dev/vdc 2>&1 || true
e2fsck -fy /dev/vdc 2>&1 || true

echo "[webx-vm] SETUP_DONE"
poweroff
'@

$setupSh | Set-Content (Join-Path $bundleDir "setup.sh") -Encoding ASCII -Force
Write-Host "[webx]   Bundled: setup.sh"

# --- Step 3.5: Create output ext4 image (written by Alpine via /dev/vdc) ------
Write-Host ""
Write-Host "[webx] === Step 3.5: Preparing output ext4 image ===" -ForegroundColor Cyan

# Put the output image on a LOCAL path so QEMU can write to it without UNC issues.
# It will be copied to $OutDir\steamos-webx.ext2 in Step 5.
$outImg = "$env:TEMP\steamos-ext4-new.img"
if (Test-Path $outImg) {
    $szMB = [math]::Round((Get-Item $outImg).Length / 1MB, 0)
    Write-Host "[webx]   Reusing existing output image ($szMB MB): $outImg" -ForegroundColor Yellow
} else {
    Write-Host "[webx]   Creating 6 GB sparse output image: $outImg"
    & $QEMU_IMG create -f raw "$outImg" 6G
    if ($LASTEXITCODE -ne 0) { Write-Error "qemu-img create failed" }
    Write-Host "[webx]   Created."
}

# --- Step 4: Boot Alpine in QEMU and automate ---------------------------------
Write-Host ""
Write-Host "[webx] === Step 4: Running Alpine QEMU VM ===" -ForegroundColor Cyan
Write-Host "[webx] This step can take 30-60 minutes (btrfs->ext4 copy is slow under TCG)."
Write-Host ""

# Detect best accelerator: WHPX (Windows Hypervisor Platform) > TCG
$accel = "tcg"
try {
    $whpxTest = & $QEMU -accel whpx -machine q35 -nographic -kernel /dev/null 2>&1
    if ($LASTEXITCODE -eq 0 -or ($whpxTest -notmatch "whpx.*not available|could not init")) {
        $accel = "whpx"
    }
} catch {}
Write-Host "[webx] QEMU accelerator: $accel"

# Allocate a free TCP port for the serial console.
# Using TCP instead of stdio avoids Windows pipe buffering issues where
# QEMU's serial output never reaches the PowerShell StreamReader.
$portListener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback, 0)
$portListener.Start()
$serialPort = $portListener.LocalEndpoint.Port
$portListener.Stop()
Write-Host "[webx] Serial console TCP port: $serialPort"

# Build QEMU argument list.
# Bundle dir shared via FAT virtual disk (no virtfs needed on Windows QEMU).
$bundleFat = $bundleDir.Replace('\', '/')   # QEMU prefers forward slashes

$outImgFwd = $outImg.Replace('\', '/')

$qemuArgs = @(
    "-m", "2048",
    "-nographic",
    "-boot", "d",
    "-drive", "file=`"$AlpineIso`",media=cdrom,readonly=on",
    "-drive", "file=`"$rootfsImg`",format=raw,if=virtio,index=0,readonly=on",
    "-drive", "file=fat:rw:$bundleFat,format=raw,if=virtio,index=1",
    "-drive", "file=`"$outImgFwd`",format=raw,if=virtio,index=2",
    "-machine", "q35",
    "-accel", $accel,
    "-serial", "tcp:127.0.0.1:${serialPort},server,nowait",
    "-monitor", "none",
    "-net", "user",
    "-net", "nic,model=virtio"
)

# Start QEMU — let stdout/stderr go directly to the console for visibility
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName       = $QEMU
$psi.Arguments      = $qemuArgs -join " "
$psi.UseShellExecute = $false

Write-Host "[webx] Launching: $QEMU $($psi.Arguments)"
Write-Host ""

$proc = [System.Diagnostics.Process]::Start($psi)

# Connect to QEMU's serial console via TCP (retrying for up to 15 s)
Write-Host "[webx] Connecting to serial console on port $serialPort..."
$tcp = New-Object System.Net.Sockets.TcpClient
$connected = $false
for ($i = 0; $i -lt 30; $i++) {
    if ($proc.HasExited) {
        Write-Error "[webx] QEMU exited unexpectedly before accepting TCP connection."
    }
    try {
        $tcp.Connect("127.0.0.1", $serialPort)
        $connected = $true
        break
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
if (-not $connected) {
    Write-Error "[webx] Could not connect to QEMU serial TCP port $serialPort."
}
Write-Host "[webx] Serial console connected."

$tcpStream             = $tcp.GetStream()
$tcpStream.ReadTimeout = 200   # ms — causes ReadByte to throw IOException when idle

# Read serial output until $Pattern matches, echoing everything to console.
function ReadUntil {
    param([string]$Pattern, [int]$TimeoutSec = 180)
    $deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
    $buf      = ""
    while ([DateTime]::Now -lt $deadline) {
        if ($proc.HasExited) {
            # Drain any remaining bytes from the TCP buffer before giving up
            $tcpStream.ReadTimeout = 100
            try {
                while ($true) {
                    $b = $tcpStream.ReadByte()
                    if ($b -lt 0) { break }
                    $ch = [char]$b; $buf += $ch
                    Write-Host $ch -NoNewline
                    if ($buf -match $Pattern) { return $true }
                }
            } catch {}
            return $false
        }
        try {
            $b = $tcpStream.ReadByte()
            if ($b -ge 0) {
                $ch    = [char]$b
                $buf  += $ch
                Write-Host $ch -NoNewline
                if ($buf -match $Pattern) { return $true }
                if ($buf.Length -gt 2000) { $buf = $buf.Substring($buf.Length - 1000) }
            }
        } catch [System.IO.IOException] {
            # ReadTimeout — no data available yet; check deadline and retry
            Start-Sleep -Milliseconds 50
        }
    }
    Write-Warning "[webx] Timed out waiting for: $Pattern"
    return $false
}

function SendLine([string]$line) {
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($line + "`r`n")
    $tcpStream.Write($bytes, 0, $bytes.Length)
    $tcpStream.Flush()
}

# --- Boot sequence ------------------------------------------------------------
Write-Host "[webx] Waiting for Alpine boot loader..."
if (-not (ReadUntil "boot:|Press.*ENTER" 90)) {
    Write-Warning "[webx] No boot prompt seen; sending Enter anyway"
}
SendLine ""   # accept default kernel

Write-Host ""
Write-Host "[webx] Waiting for Alpine login prompt (TCG emulation can be slow)..."
if (-not (ReadUntil "localhost login:|login:" 600)) {
    Write-Warning "[webx] No login prompt - Alpine may be stuck. Check output above."
}
SendLine "root"   # no password on Alpine live

Write-Host ""
Write-Host "[webx] Waiting for shell prompt..."
ReadUntil "localhost:~#|# $" 30 | Out-Null

# --- Mount FAT bundle disk (/dev/vdb) -----------------------------------------
Write-Host ""
Write-Host "[webx] Mounting FAT bundle disk (/dev/vdb1) at /bundle..."
# QEMU vvfat presents as a disk with MBR partition table; FAT is on partition 1.
# Mount at /bundle (not /mnt/bundle) so it won't be hidden when we mount btrfs at /mnt.
SendLine "mkdir -p /bundle && mount /dev/vdb1 /bundle -t vfat -o ro 2>&1 || echo MOUNT_FAILED"
ReadUntil "MOUNT_FAILED|localhost:~#|# $" 30 | Out-Null

# --- Run setup script ---------------------------------------------------------
Write-Host ""
Write-Host "[webx] Running setup script..."
SendLine "sh /bundle/setup.sh"

# Wait for SETUP_DONE marker or poweroff.
# rsync of 5 GB btrfs->ext4 under TCG can take 30-60 minutes.
$done = ReadUntil "SETUP_DONE|reboot: Power down|System halted" 7200
if ($done) {
    Write-Host ""
    Write-Host "[webx] Setup script completed successfully." -ForegroundColor Green
} else {
    Write-Warning "[webx] Timed out waiting for setup completion."
}

# Close TCP connection
try { $tcpStream.Close() } catch {}
try { $tcp.Close()       } catch {}

# Wait for QEMU to exit (setup.sh calls poweroff after rsync+tune2fs)
Write-Host "[webx] Waiting for QEMU to exit..."
if (-not $proc.WaitForExit(300000)) {
    Write-Warning "[webx] QEMU did not exit cleanly; terminating."
    $proc.Kill()
}

# --- Step 5: Copy output image to final destination ---------------------------
Write-Host ""
Write-Host "[webx] === Step 5: Finalizing ===" -ForegroundColor Cyan

# $outImg is the ext2-converted image written by Alpine to /dev/vdc (local TEMP path).
# Copy it to the final output location in $OutDir.
$finalImg = Join-Path $OutDir "steamos-webx.ext2"
Write-Host "[webx] Copying output image to: $finalImg"
Copy-Item $outImg $finalImg -Force

$finalMB = [math]::Round((Get-Item $finalImg).Length / 1MB, 0)
Write-Host ""
Write-Host "[webx] =================================================" -ForegroundColor Green
Write-Host "[webx] Done!  $finalImg" -ForegroundColor Green
Write-Host "[webx] Size:  $finalMB MB"
Write-Host ""
Write-Host "[webx] Serve this file at /images/steamos-webx.ext2 with:"
Write-Host "         Cross-Origin-Opener-Policy: same-origin"
Write-Host "         Cross-Origin-Embedder-Policy: require-corp"
Write-Host ""
Write-Host "[webx] Then update STEAMOS_IMAGE_URL in harness/cheerpx-host.mjs."
Write-Host "[webx] =================================================" -ForegroundColor Green
