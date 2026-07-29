# Launch Chrome test fleet — one instance per project
# Usage: powershell -File cli/launch-test-fleet.ps1

$Projects = @(
    @{ Name="StackDive";  Port=3000; CdpPort=9222 },
    @{ Name="FieldTrip";  Port=3001; CdpPort=9223 },
    @{ Name="Dzidzor";    Port=3002; CdpPort=9224 }
)

$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"

foreach ($p in $Projects) {
    $userDir = "C:\Users\bubun\ChromeTest$($p.CdpPort)"
    $url = "http://localhost:$($p.Port)"

    Write-Host "Launching $($p.Name): CDP=$($p.CdpPort) -> $url"

    Start-Process $ChromePath -ArgumentList @(
        "--remote-debugging-port=$($p.CdpPort)",
        "--user-data-dir=$userDir",
        "--no-first-run",
        $url
    )

    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "Fleet launched. Verify with:"
foreach ($p in $Projects) {
    Write-Host "  CDP_PORT=$($p.CdpPort) node cli/tt.mjs scan  # $($p.Name)"
}
