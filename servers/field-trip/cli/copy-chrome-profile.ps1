# Copy your real Chrome profile cookies/sessions to a test profile
# This lets you use your saved logins in the debugging Chrome instance
#
# Usage: powershell -File cli/copy-chrome-profile.ps1 [-CdpPort 9222]
#
# IMPORTANT: Close Chrome before running this script

param(
    [int]$CdpPort = 9222
)

$source = "$env:LOCALAPPDATA\Google\Chrome\User Data"
$dest = "C:\Users\bubun\ChromeTest$CdpPort"

# Check Chrome is not running
$chromeProcs = Get-Process chrome -ErrorAction SilentlyContinue
if ($chromeProcs) {
    Write-Host "Chrome is running. Close it first or run:" -ForegroundColor Red
    Write-Host "  Stop-Process -Name chrome -Force" -ForegroundColor Yellow
    exit 1
}

Write-Host "Copying Chrome profile from: $source"
Write-Host "                         to: $dest"
Write-Host ""

# Copy Default profile (cookies, passwords, localStorage, extensions)
Write-Host "Copying cookies, passwords, localStorage..."
robocopy "$source\Default" "$dest\Default" /E /XD "Cache" "Code Cache" "Service Worker" "GPUCache" "blob_storage" "IndexedDB" /NFL /NDL /NJH /NJS /NC /NS

# Copy Local State (encryption keys for cookies)
Write-Host "Copying encryption state..."
robocopy "$source" "$dest" "Local State" /IS /NFL /NDL /NJH /NJS /NC /NS

# Copy extension state if needed
if (Test-Path "$source\Default\Extensions") {
    Write-Host "Copying extensions..."
    robocopy "$source\Default\Extensions" "$dest\Default\Extensions" /E /NFL /NDL /NJH /NJS /NC /NS
}

Write-Host ""
Write-Host "Done! Your test Chrome at port $CdpPort now has your saved logins." -ForegroundColor Green
Write-Host ""
Write-Host "Launch with:"
Write-Host "  Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' ``" -ForegroundColor Cyan
Write-Host "    -ArgumentList '--remote-debugging-port=$CdpPort','--user-data-dir=$dest','--no-first-run'" -ForegroundColor Cyan
