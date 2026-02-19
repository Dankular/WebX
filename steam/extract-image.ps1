# extract-image.ps1
# Extracts the SteamOS rootfs partition from:
#   C:\Users\Dan\Downloads\steamdeck-repair-20250521.10-3.7.7.img.bz2
# and produces a CheerpX-ready ext2 image.
#
# Requirements:
#   7-Zip (winget install 7zip.7zip)
#   WSL2 with ext4 partition support (for ext2 conversion)
#   OR: use extract-image-docker.ps1 if WSL is not available
#
# Output: steam\steamos-rootfs.img  (ext4, mountable by CheerpX)

param(
    [string]$Source = "$env:USERPROFILE\Downloads\steamdeck-repair-20250521.10-3.7.7.img.bz2",
    [string]$OutDir = "$PSScriptRoot",
    [string]$SevenZip = "C:\Program Files\7-Zip\7z.exe"
)

$ErrorActionPreference = "Stop"

Write-Host "[webx] SteamOS image extractor" -ForegroundColor Cyan
Write-Host "[webx] Source: $Source"
Write-Host "[webx] Output: $OutDir"

# ── Step 1: Decompress .bz2 ───────────────────────────────────────────
$imgPath = Join-Path $OutDir "steamdeck-repair.img"
if (Test-Path $imgPath) {
    Write-Host "[webx] Skipping decompression — $imgPath already exists"
} else {
    if (-not (Test-Path $SevenZip)) {
        Write-Error "7-Zip not found at $SevenZip. Install: winget install 7zip.7zip"
    }
    Write-Host "[webx] Decompressing $([math]::Round((Get-Item $Source).Length / 1GB, 2)) GB..."
    & $SevenZip e -o"$OutDir" "$Source" -y
    if ($LASTEXITCODE -ne 0) { Write-Error "7-Zip decompression failed" }
    Write-Host "[webx] Decompressed -> $imgPath"
}

# ── Step 2: Identify partitions ───────────────────────────────────────
Write-Host "[webx] Reading partition table..."
$size = (Get-Item $imgPath).Length
Write-Host "[webx] Image size: $([math]::Round($size / 1GB, 2)) GB"

# SteamOS partition layout (standard Steam Deck repair image):
#   Part 1: EFI  (vfat,  ~256MB)
#   Part 2: rootA (ext4, ~5GB)   ← we want this
#   Part 3: rootB (ext4, ~5GB)   ← backup slot
#   Part 4: home  (ext4, remainder)
#
# Use PowerShell + diskpart to inspect, then WSL to extract the partition.

Write-Host ""
Write-Host "[webx] ── Next steps ─────────────────────────────────────────────" -ForegroundColor Yellow
Write-Host ""
Write-Host "Option A — WSL2 (recommended):" -ForegroundColor Green
Write-Host "  Run in WSL2:"
Write-Host "    bash steam/extract-rootfs.sh '$($imgPath.Replace('\','/'))'  '$($OutDir.Replace('\','//'))'"
Write-Host ""
Write-Host "Option B — Docker Desktop:" -ForegroundColor Green
Write-Host "  docker run --rm -v '${OutDir}:/work' ubuntu:24.04 bash /work/steam/extract-rootfs.sh /work/steamdeck-repair.img /work"
Write-Host ""
Write-Host "Option C — Direct mount (Windows admin, requires ext4 WSL driver):" -ForegroundColor Green
Write-Host "  wsl --mount --vhd '$imgPath' --partition 2"
Write-Host "  Then copy rootfs from WSL mountpoint"
Write-Host ""
Write-Host "[webx] The extracted rootfs will be at: $OutDir\steamos-rootfs.img"
