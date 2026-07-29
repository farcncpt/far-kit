# far-kit setup (Windows) — installs runtime deps for every bundled MCP server.
# Run: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "== far-kit setup =="
$dirs = @(
  "servers/truth-seeker",
  "servers/internal-code",
  "servers/refactor-runtime",
  "servers/field-trip",
  "servers/field-trip/mcp-server"
)
foreach ($d in $dirs) {
  $full = Join-Path $Root $d
  if (Test-Path (Join-Path $full "package.json")) {
    Write-Host "-- npm install: $d"
    Push-Location $full
    npm install --omit=dev --no-audit --no-fund --loglevel=error
    Pop-Location
  }
}

Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  1. Load the Chrome extension: chrome://extensions -> Developer mode -> Load unpacked -> servers\field-trip\extension"
Write-Host "  2. Start the relay:           node servers\field-trip\cli\ws-relay.mjs   (port 9333)"
Write-Host "  3. Tab ownership panel:       http://localhost:9333/"
Write-Host "  4. Install the plugin:        /plugin marketplace add <this repo> ; /plugin install far-kit@far-kit"
