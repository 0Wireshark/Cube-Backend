param(
    [string]$ConfigPath = ".\Config\config.json",
    [string]$MatchmakerUrl = "",
    [int]$IntervalSeconds = 5,
    [int]$TtlSeconds = 15,
    [string]$WindowTitlePattern = "Joinable",
    [switch]$ForceOnline
)

function Convert-MatchmakerUrl {
    param([string]$RawUrl)

    $value = $RawUrl.Trim()
    if ($value.EndsWith("/gs/heartbeat")) { return $value }
    if ($value.StartsWith("wss://")) { return "https://" + $value.Substring(6).TrimEnd("/") + "/gs/heartbeat" }
    if ($value.StartsWith("ws://")) { return "http://" + $value.Substring(5).TrimEnd("/") + "/gs/heartbeat" }
    if ($value.StartsWith("https://") -or $value.StartsWith("http://")) { return $value.TrimEnd("/") + "/gs/heartbeat" }
    return "http://" + $value.TrimEnd("/") + "/gs/heartbeat"
}

function Convert-GameServerEntry {
    param([string]$Entry)

    $parts = $Entry.Split(":")
    if ($parts.Length -lt 2) { return $null }

    $port = 0
    if (-not [int]::TryParse($parts[1], [ref]$port)) { return $null }
    if ($port -lt 1 -or $port -gt 65535) { return $null }

    $beaconPort = $port
    if ($parts.Length -ge 4) {
        [void][int]::TryParse($parts[3], [ref]$beaconPort)
    }

    return [PSCustomObject]@{
        ip = $parts[0]
        port = $port
        playlist = if ($parts.Length -ge 3 -and $parts[2]) { $parts[2] } else { "playlist_defaultsolo" }
        beaconPort = $beaconPort
    }
}

function Test-LocalUdpPort {
    param([int]$Port)

    $endpoint = Get-NetUDPEndpoint -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq $Port } |
        Select-Object -First 1

    return $null -ne $endpoint
}

function Test-JoinableWindow {
    param([string]$Pattern)

    if (-not $Pattern) { return $false }

    $window = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -match $Pattern } |
        Select-Object -First 1

    return $null -ne $window
}

if (-not (Test-Path $ConfigPath)) {
    Write-Host "Config introuvable: $ConfigPath"
    exit 1
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$targetUrl = if ($MatchmakerUrl) { Convert-MatchmakerUrl $MatchmakerUrl } else { Convert-MatchmakerUrl $config.matchmakerIP }
$secret = if ($config.matchmakerHeartbeatSecret) { $config.matchmakerHeartbeatSecret } else { $config.gsAuth.secret }
$servers = @($config.gameServerIP | ForEach-Object { Convert-GameServerEntry $_ } | Where-Object { $_ })

if ($servers.Count -eq 0) {
    Write-Host "Aucun gameServerIP valide dans la config."
    exit 1
}

Write-Host "Heartbeat vers $targetUrl"
Write-Host "Serveurs surveilles: $($servers | ForEach-Object { "$($_.ip):$($_.port)/$($_.playlist)" })"
if ($ForceOnline) {
    Write-Host "Mode ForceOnline actif: heartbeat envoye meme si Windows ne voit pas le port UDP local."
} else {
    Write-Host "Detection active: port UDP local ou fenetre qui match '$WindowTitlePattern'."
}

while ($true) {
    $onlineServers = if ($ForceOnline) {
        @($servers)
    } else {
        $joinableWindow = Test-JoinableWindow $WindowTitlePattern
        @($servers | Where-Object { $joinableWindow -or (Test-LocalUdpPort $_.port) })
    }

    if ($onlineServers.Count -gt 0) {
        $body = @{
            ttlSeconds = $TtlSeconds
            servers = $onlineServers
        } | ConvertTo-Json -Depth 4

        try {
            Invoke-RestMethod -Method Post -Uri $targetUrl -ContentType "application/json" -Headers @{ "x-gs-secret" = $secret } -Body $body | Out-Null
            Write-Host "$(Get-Date -Format HH:mm:ss) heartbeat OK ($($onlineServers.Count) serveur(s))"
        } catch {
            Write-Host "$(Get-Date -Format HH:mm:ss) heartbeat fail: $($_.Exception.Message)"
        }
    } else {
        Write-Host "$(Get-Date -Format HH:mm:ss) aucun port UDP/fenetre joinable detecte, heartbeat non envoye. Utilise -ForceOnline si CubeGS est bien joinable."
    }

    Start-Sleep -Seconds $IntervalSeconds
}
