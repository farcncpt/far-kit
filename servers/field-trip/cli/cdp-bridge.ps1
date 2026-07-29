# CDP Bridge - Navigate and interact with Chrome via DevTools Protocol
param(
    [string]$Action = "list",
    [string]$Url = "",
    [string]$Expression = "",
    [int]$Port = 9223
)

$cdpBase = "http://127.0.0.1:$Port"

switch ($Action) {
    "list" {
        $r = Invoke-WebRequest -Uri "$cdpBase/json" -UseBasicParsing -TimeoutSec 5
        $r.Content | ConvertFrom-Json | Select-Object id, title, url, type | Format-Table -AutoSize
    }
    "navigate" {
        # Get first page tab
        $r = Invoke-WebRequest -Uri "$cdpBase/json" -UseBasicParsing -TimeoutSec 5
        $tabs = $r.Content | ConvertFrom-Json
        $page = $tabs | Where-Object { $_.type -eq "page" } | Select-Object -First 1
        if (-not $page) {
            # Create new tab
            $r = Invoke-WebRequest -Uri "$cdpBase/json/new?$Url" -UseBasicParsing -TimeoutSec 5
            Write-Output "Created new tab"
        } else {
            # Navigate existing tab via WebSocket
            $wsUrl = $page.webSocketDebuggerUrl
            Write-Output "Navigating tab $($page.id) to $Url"
            # Use CDP to navigate
            $ws = New-Object System.Net.WebSockets.ClientWebSocket
            $ct = New-Object System.Threading.CancellationToken
            $ws.ConnectAsync([Uri]$wsUrl, $ct).Wait()

            $msg = @{
                id = 1
                method = "Page.navigate"
                params = @{ url = $Url }
            } | ConvertTo-Json -Compress

            $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
            $segment = New-Object System.ArraySegment[byte] -ArgumentList (,$bytes)
            $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()

            # Read response
            $buf = New-Object byte[] 4096
            $seg = New-Object System.ArraySegment[byte] -ArgumentList (,$buf)
            $result = $ws.ReceiveAsync($seg, $ct).Result
            $response = [System.Text.Encoding]::UTF8.GetString($buf, 0, $result.Count)
            Write-Output $response

            $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "", $ct).Wait()
        }
    }
    "eval" {
        # Get page tab
        $r = Invoke-WebRequest -Uri "$cdpBase/json" -UseBasicParsing -TimeoutSec 5
        $tabs = $r.Content | ConvertFrom-Json
        $page = $tabs | Where-Object { $_.type -eq "page" -and $_.url -notlike "chrome://*" -and $_.url -notlike "chrome-extension://*" } | Select-Object -First 1
        if (-not $page) {
            Write-Error "No page tab found"
            return
        }

        $wsUrl = $page.webSocketDebuggerUrl
        $ws = New-Object System.Net.WebSockets.ClientWebSocket
        $ct = New-Object System.Threading.CancellationToken
        $ws.ConnectAsync([Uri]$wsUrl, $ct).Wait()

        $msg = @{
            id = 1
            method = "Runtime.evaluate"
            params = @{
                expression = $Expression
                returnByValue = $true
            }
        } | ConvertTo-Json -Compress -Depth 5

        $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
        $segment = New-Object System.ArraySegment[byte] -ArgumentList (,$bytes)
        $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()

        # Read response (may need multiple reads for large results)
        $allBytes = New-Object System.Collections.Generic.List[byte]
        do {
            $buf = New-Object byte[] 65536
            $seg = New-Object System.ArraySegment[byte] -ArgumentList (,$buf)
            $result = $ws.ReceiveAsync($seg, $ct).Result
            for ($i = 0; $i -lt $result.Count; $i++) {
                $allBytes.Add($buf[$i])
            }
        } while (-not $result.EndOfMessage)

        $response = [System.Text.Encoding]::UTF8.GetString($allBytes.ToArray())
        Write-Output $response

        $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "", $ct).Wait()
    }
    "new-tab" {
        $r = Invoke-WebRequest -Uri "$cdpBase/json/new?$Url" -UseBasicParsing -TimeoutSec 5
        $r.Content
    }
}
