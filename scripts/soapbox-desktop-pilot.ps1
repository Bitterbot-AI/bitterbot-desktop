[CmdletBinding()]
param([ValidateSet('Start','Stop','Status')][string]$Action = 'Start', [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$integratedMarker = '\\wsl.localhost\Ubuntu\home\vicmg\.bitterbot\compute\active.json'
if (Test-Path -LiteralPath $integratedMarker) {
    Write-Host 'Compute is managed by your main Bitterbot app at http://127.0.0.1:19001/. Open Compute in its sidebar.'
    if ($Action -eq 'Stop') {
        Write-Host 'Use Pause in the Compute operator panel to stop accepting work.'
    } elseif ($Action -eq 'Start' -and !$NoOpen) {
        Start-Process 'http://127.0.0.1:19001/'
    }
    return
}
if ($Action -ne 'Stop') {
    try {
        $pilotReadyResponse = Invoke-WebRequest 'http://127.0.0.1:19031/' -UseBasicParsing -TimeoutSec 3
        if ($pilotReadyResponse.StatusCode -eq 200 -and $pilotReadyResponse.Content -match '<title>Bitterbot</title>') {
            Write-Host 'Bitterbot Soapbox is running at http://127.0.0.1:19031 (Base Sepolia testnet).'
            if ($Action -eq 'Start' -and !$NoOpen) { Start-Process 'http://127.0.0.1:19031/' }
            return
        }
    } catch { <# Continue with service startup or status inspection. #> }
}
$pilotRoot = Split-Path -Parent $PSScriptRoot
for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $linuxRoot = (& wsl -d Ubuntu --exec wslpath -a $pilotRoot).Trim()
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 2
}
if ($LASTEXITCODE -ne 0) { throw 'Could not connect to WSL Ubuntu. Retry the launcher; the main gateway has not been changed.' }
if ($Action -eq 'Start') {
    & wsl -d Ubuntu --exec sh -c 'docker info >/dev/null 2>&1'
    if ($LASTEXITCODE -ne 0) {
        $engineScript = "$linuxRoot/../soapbox/scripts/start-container-engine.sh"
        & wsl -d Ubuntu -u root --exec sh -c 'nohup bash "$1" >/tmp/soapbox-container-engine.log 2>&1 </dev/null &' soapbox-engine $engineScript
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Seconds 1
            & wsl -d Ubuntu --exec sh -c 'docker info >/dev/null 2>&1'
            if ($LASTEXITCODE -eq 0) { break }
        }
        if ($LASTEXITCODE -ne 0) { throw 'The isolated Docker engine did not become ready.' }
    }
}
if ($Action -eq 'Start') {
    & wsl -d Ubuntu --exec bash "$linuxRoot/scripts/soapbox-desktop-pilot.sh" check
    if ($LASTEXITCODE -ne 0) {
        Start-Process -FilePath 'wsl.exe' -WindowStyle Hidden -ArgumentList @('-d','Ubuntu','--exec','bash',"$linuxRoot/scripts/soapbox-desktop-pilot.sh",'run')
        Write-Host 'Starting Soapbox at http://127.0.0.1:19031. Initial startup can take a few minutes.'
    } else { Write-Host 'Soapbox is already running at http://127.0.0.1:19031.' }
} else {
    & wsl -d Ubuntu --exec bash "$linuxRoot/scripts/soapbox-desktop-pilot.sh" $Action.ToLowerInvariant()
    if ($LASTEXITCODE -ne 0) { throw 'Pilot command failed. See ~/.bitterbot-soapbox-pilot/pilot.log in WSL.' }
}
if ($Action -eq 'Start' -and !$NoOpen) {
    for ($attempt = 0; $attempt -lt 180; $attempt++) {
        try {
            $response = Invoke-WebRequest 'http://127.0.0.1:19031/' -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) { Start-Process 'http://127.0.0.1:19031/'; return }
        } catch { Start-Sleep -Seconds 3 }
    }
    throw 'The pilot is still starting. Check Status and the WSL pilot.log.'
}
