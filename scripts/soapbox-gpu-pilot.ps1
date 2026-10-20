[CmdletBinding()]
param([switch]$TestOnly)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$soapbox = Join-Path (Split-Path -Parent $repo) 'soapbox'
$binary = Join-Path $soapbox '.local/bin/soapbox.exe'
if (!(Test-Path -LiteralPath $binary)) { throw 'Build the native Soapbox executable first. See docs/network/soapbox.md.' }
if (!$TestOnly -and !(Test-Path -LiteralPath (Join-Path $repo 'desktop/dist-renderer/index.html'))) {
    throw 'Build the desktop renderer first: run the Vite build from desktop/.'
}
$keys = @('SOAPBOX_BINARY','SOAPBOX_REPORT','ESBUILD_BINARY_PATH','NODE_PATH')
$previous = @{}
foreach ($key in $keys) { $previous[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
$owned = $null
Push-Location $repo
try {
    try { $runtime = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 3 } catch { $runtime = $null }
    if (!$runtime) {
        & (Join-Path $soapbox 'scripts/setup-gpu.ps1') -KeepRuntime
        $runtimeId = [int](Get-Content -LiteralPath (Join-Path $soapbox '.local/ollama.pid'))
        $owned = Get-Process -Id $runtimeId
        if ($owned.Path -ne (Join-Path $soapbox '.local/ollama/ollama.exe')) { throw 'Unexpected runtime process' }
    }
    $env:SOAPBOX_BINARY = $binary
    $env:SOAPBOX_REPORT = Join-Path $soapbox '.local/gpu-validation.json'
    # Optional local accommodations for this WSL-installed dependency checkout.
    $esbuild = Join-Path $soapbox '.local/esbuild/package/esbuild.exe'
    if (!$env:ESBUILD_BINARY_PATH -and (Test-Path -LiteralPath $esbuild)) { $env:ESBUILD_BINARY_PATH = $esbuild }
    $redirects = Join-Path $repo 'node_modules/.pnpm/follow-redirects@1.15.11_debug@4.4.3/node_modules'
    if (Test-Path -LiteralPath $redirects) { $env:NODE_PATH = (@($env:NODE_PATH,$redirects) | Where-Object { $_ }) -join ';' }
    $arguments = @('--import','tsx','scripts/soapbox-smoke.ts','--gpu')
    if (!$TestOnly) { $arguments += '--keep' }
    & node @arguments
    if ($LASTEXITCODE -ne 0) { throw "GPU pilot failed with exit code $LASTEXITCODE" }
} finally {
    if ($owned -and !$owned.HasExited) {
        $runtimeRoot = [IO.Path]::GetFullPath((Join-Path $soapbox '.local/ollama')) + [IO.Path]::DirectorySeparatorChar
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($owned.Id)" | ForEach-Object {
            if ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($runtimeRoot,[StringComparison]::OrdinalIgnoreCase)) {
                Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            }
        }
        Stop-Process -Id $owned.Id -ErrorAction SilentlyContinue
    }
    foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key,$previous[$key],'Process') }
    Pop-Location
}
