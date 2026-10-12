<#
.SYNOPSIS
  Bitterbot installer for Windows (PLAN-56 Phase 3b): installs inside WSL2.

.DESCRIPTION
  Bitterbot's release tarballs are built for Linux and macOS. On Windows this
  script finds WSL2 and runs the Linux installer (scripts/install.sh) inside
  your default WSL2 distribution, where Bitterbot keeps its data in the Linux
  home directory (~/.bitterbot, on the ext4 filesystem).

  Without WSL2 it prints how to enable it (wsl --install) and the Docker
  Desktop alternative, then exits with code 2. It never needs administrator
  rights to detect anything, and it changes nothing on Windows itself.

  A native Windows install and a Scheduled Task runner are not part of this
  version (see docs/platforms/windows.md).

  Usage (PowerShell 5.1 or 7):
    irm https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.ps1 | iex
  or, to pass options, save it first:
    .\install.ps1 -Version 1.6.0 -NoOnboard
    .\install.ps1 -WhatIf      # print the plan, run nothing
    (piped into iex: set $env:BITTERBOT_INSTALL_DRY_RUN = '1' for the same)

  Exit codes: 0 installed (or -WhatIf plan printed), 1 error, 2 WSL2 missing.

.PARAMETER Version
  Install this release (X.Y.Z) instead of the newest complete one.

.PARAMETER Distro
  Use this WSL distribution instead of the default one.

.PARAMETER NoOnboard
  Do not run `bitterbot onboard` after installing.

.PARAMETER Yes
  Do not ask for confirmation inside the Linux installer.
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer output for a console user.')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Version = '',
  [string]$Distro = '',
  [switch]$NoOnboard,
  [switch]$Yes
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:InstallShUrl = 'https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.sh'
$script:DockerDocsUrl = 'https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/platforms/docker.md'
$script:WindowsDocsUrl = 'https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/platforms/windows.md'

function Write-BbLine {
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer output for a console user.')]
  param([string]$Text = '')
  Write-Host $Text
}

# wsl.exe prints UTF-16 unless WSL_UTF8=1 (newer WSL); strip NULs either way.
function Get-BbWslOutput {
  param([string[]]$Arguments)
  $previous = $env:WSL_UTF8
  $env:WSL_UTF8 = '1'
  try {
    $raw = & wsl.exe @Arguments 2>$null
    $code = $LASTEXITCODE
  } catch {
    return [pscustomobject]@{ Code = 1; Lines = @() }
  } finally {
    $env:WSL_UTF8 = $previous
  }
  $lines = @()
  foreach ($line in @($raw)) {
    if ($null -ne $line) {
      $clean = ([string]$line) -replace "`0", ''
      if ($clean.Trim().Length -gt 0) {
        $lines += $clean
      }
    }
  }
  return [pscustomobject]@{ Code = $code; Lines = $lines }
}

# Distributions from `wsl -l -v`: name, WSL version, default flag.
function Get-BbWslDistro {
  $fake = $env:BITTERBOT_INSTALL_PS1_FAKE_WSL
  if ($script:DryRun -and $fake) {
    switch ($fake) {
      'none' { return @() }
      'wsl1' { return @([pscustomobject]@{ Name = 'Ubuntu'; Version = 1; IsDefault = $true }) }
      'wsl2' { return @([pscustomobject]@{ Name = 'Ubuntu'; Version = 2; IsDefault = $true }) }
      default { throw "BITTERBOT_INSTALL_PS1_FAKE_WSL must be none, wsl1 or wsl2" }
    }
  }
  if (-not (Get-Command -Name 'wsl.exe' -ErrorAction SilentlyContinue)) {
    return @()
  }
  $out = Get-BbWslOutput -Arguments @('--list', '--verbose')
  if ($out.Code -ne 0) {
    return @()
  }
  $distros = @()
  foreach ($line in $out.Lines) {
    $m = [regex]::Match($line, '^\s*(\*?)\s*(\S+)\s+(\S+)\s+([12])\s*$')
    if ($m.Success -and $m.Groups[2].Value -ne 'NAME') {
      $distros += [pscustomobject]@{
        Name      = $m.Groups[2].Value
        Version   = [int]$m.Groups[4].Value
        IsDefault = ($m.Groups[1].Value -eq '*')
      }
    }
  }
  return $distros
}

function Show-BbWslHelp {
  param([string]$Reason)
  Write-BbLine "Bitterbot on Windows runs inside WSL2 (Windows Subsystem for Linux 2)."
  Write-BbLine "  $Reason"
  Write-BbLine ''
  Write-BbLine 'Enable WSL2 (one time, needs an administrator PowerShell and a restart):'
  Write-BbLine '  wsl --install'
  Write-BbLine '  (an existing WSL1 distribution: wsl --set-version <name> 2)'
  Write-BbLine 'Then open the new Ubuntu terminal once to create your Linux user, and run this script again.'
  Write-BbLine ''
  Write-BbLine 'Alternative without WSL: Docker Desktop with the published image:'
  Write-BbLine "  $script:DockerDocsUrl"
  Write-BbLine "More: $script:WindowsDocsUrl"
}

function Get-BbInstallCommand {
  param(
    [string]$ReleaseVersion,
    [bool]$SkipOnboard,
    [bool]$AssumeYes
  )
  $flags = @()
  if ($ReleaseVersion) {
    if ($ReleaseVersion -notmatch '^v?\d+\.\d+\.\d+$') {
      throw "-Version must look like 1.6.0 (got '$ReleaseVersion')"
    }
    $flags += @('--version', ($ReleaseVersion -replace '^v', ''))
  }
  if ($SkipOnboard) { $flags += '--no-onboard' }
  if ($AssumeYes) { $flags += '--yes' }
  $tail = ''
  if ($flags.Count -gt 0) {
    $tail = ' -s -- ' + ($flags -join ' ')
  }
  return "curl -fsSL $script:InstallShUrl | bash$tail"
}

# Pick the WSL2 distribution and print the plan. Returns Code 0 with the
# target and command, or Code 2 after printing how to get WSL2.
function Get-BbInstallPlan {
  param([string]$DistroName, [string]$Command)
  $distros = @(Get-BbWslDistro)
  if ($distros.Count -eq 0) {
    Show-BbWslHelp -Reason 'No WSL distribution was found on this machine.'
    return [pscustomobject]@{ Code = 2; Target = $null }
  }
  if ($DistroName) {
    $target = $distros | Where-Object { $_.Name -eq $DistroName } | Select-Object -First 1
    if (-not $target) {
      $names = ($distros | ForEach-Object { $_.Name }) -join ', '
      Show-BbWslHelp -Reason "There is no WSL distribution named '$DistroName' (found: $names)."
      return [pscustomobject]@{ Code = 2; Target = $null }
    }
  } else {
    $target = $distros | Where-Object { $_.IsDefault } | Select-Object -First 1
    if (-not $target) { $target = $distros[0] }
  }
  if ($target.Version -ne 2) {
    Show-BbWslHelp -Reason "The distribution '$($target.Name)' runs on WSL1; Bitterbot needs WSL2 (wsl --set-version $($target.Name) 2)."
    return [pscustomobject]@{ Code = 2; Target = $null }
  }
  Write-BbLine 'Bitterbot installer for Windows'
  Write-BbLine ''
  Write-BbLine "  WSL2 distribution: $($target.Name)"
  Write-BbLine "  Runs inside it:    $Command"
  Write-BbLine '  Installs to:       ~/.bitterbot/app in your Linux home (ext4), command ~/.local/bin/bitterbot'
  Write-BbLine '  Windows itself:    nothing is changed'
  Write-BbLine ''
  Write-BbLine 'Keep Bitterbot on the Linux filesystem: if you also clone the source, clone it into your'
  Write-BbLine 'Linux home (cd ~ && git clone ...), not under /mnt/c, which is much slower and breaks file watching.'
  Write-BbLine ''
  return [pscustomobject]@{ Code = 0; Target = $target }
}

function Invoke-BbLinuxInstaller {
  param([string]$DistroName, [string]$Command)
  $probe = Get-BbWslOutput -Arguments @('-d', $DistroName, '-e', 'sh', '-c', 'command -v curl')
  if ($probe.Code -ne 0) {
    Write-BbLine "curl is missing in '$DistroName'. Install it there first (Ubuntu/Debian: sudo apt-get install -y curl) and run this script again."
    return 1
  }
  & wsl.exe -d $DistroName -e bash -lc $Command
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-BbLine "The Linux installer exited with code $code."
    return 1
  }
  Write-BbLine ''
  Write-BbLine "Done. Open your WSL terminal (wsl -d $DistroName) and run: bitterbot gateway"
  return 0
}

# -WhatIf, or BITTERBOT_INSTALL_DRY_RUN=1 (works when piped into iex, where
# script parameters cannot be passed): print the plan, run nothing.
$script:DryRun = [bool]$WhatIfPreference -or ($env:BITTERBOT_INSTALL_DRY_RUN -eq '1')
# Piped into Invoke-Expression the script is not an advanced script, so
# there is no $PSCmdlet to ask ShouldProcess.
$script:Cmdlet = Get-Variable -Name PSCmdlet -ValueOnly -ErrorAction SilentlyContinue
$exitCode = 1
try {
  $command = Get-BbInstallCommand -ReleaseVersion $Version -SkipOnboard $NoOnboard.IsPresent -AssumeYes $Yes.IsPresent
  $plan = Get-BbInstallPlan -DistroName $Distro -Command $command
  $exitCode = $plan.Code
  if ($plan.Code -eq 0) {
    $proceed = -not $script:DryRun
    if ($script:Cmdlet) {
      $proceed = $script:Cmdlet.ShouldProcess("WSL2 distribution '$($plan.Target.Name)'", 'Run the Bitterbot Linux installer') -and -not $script:DryRun
    }
    if ($proceed) {
      $exitCode = Invoke-BbLinuxInstaller -DistroName $plan.Target.Name -Command $command
    } else {
      Write-BbLine 'WhatIf: nothing was run.'
    }
  }
} catch {
  Write-BbLine "ERROR: $($_.Exception.Message)"
  $exitCode = 1
}
# Run as a file (powershell -File, .\install.ps1): report the exit code.
# Piped into Invoke-Expression there is no script file, and `exit` would
# close the user's PowerShell window.
if ($PSCommandPath) {
  exit $exitCode
}
# Piped into Invoke-Expression: do not close the user's session.
if ($exitCode -ne 0) {
  Write-BbLine "(installer finished with code $exitCode)"
}
