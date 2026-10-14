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

  Upgrading: inside WSL the Linux installer offers to switch a running older
  Bitterbot (a git clone started with pnpm, an older release, or its
  background service) to the new version with `bitterbot gateway switch`,
  asked once (default yes); -Yes switches without asking, -NoSwitch leaves
  it alone. A gateway installed natively on Windows from a git clone (the
  "Bitterbot Gateway" scheduled task) is detected and reported with the
  commands to stop it; this script never changes it.

  Usage (PowerShell 5.1 or 7):
    irm https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.ps1 | iex
  or, to pass options, save it first:
    .\install.ps1 -Version 1.6.0 -NoOnboard
    .\install.ps1 -WhatIf      # print the plan, run nothing
    (piped into iex: set $env:BITTERBOT_INSTALL_DRY_RUN = '1' for the same)

  Exit codes: 0 installed (or -WhatIf plan printed), 1 error, 2 WSL2 missing.
  Piped into iex it never exits your session or script: the code is left in
  $LASTEXITCODE, and nothing else (functions, variables, StrictMode,
  $ErrorActionPreference) is left behind.

.PARAMETER Version
  Install this release (X.Y.Z) instead of the newest complete one.

.PARAMETER Distro
  Use this WSL distribution instead of the default one.

.PARAMETER NoOnboard
  Do not run `bitterbot onboard` after installing.

.PARAMETER Yes
  Do not ask for confirmation inside the Linux installer (this also switches
  a running older Bitterbot inside WSL to the new version).

.PARAMETER NoSwitch
  Leave a running older Bitterbot inside WSL (and its background service)
  alone.
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer output for a console user.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidGlobalVars', '', Justification = 'Piped into iex the exit code is reported in $LASTEXITCODE, the way a native command reports it.')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Version = '',
  [string]$Distro = '',
  [switch]$NoOnboard,
  [switch]$Yes,
  [switch]$NoSwitch
)

# Everything runs inside one script block: its functions, variables,
# StrictMode and $ErrorActionPreference stay in that scope and vanish when it
# returns, so `irm ... | iex` leaves the caller's session as it was. Native
# output is not captured (the block's output is not assigned), so the Linux
# installer keeps the console.
& {
  param(
    [string]$ReleaseVersion,
    [string]$DistroName,
    [bool]$SkipOnboard,
    [bool]$AssumeYes,
    [bool]$SkipSwitch,
    [bool]$DryRun,
    $Cmdlet,
    [bool]$RunAsFile
  )

  Set-StrictMode -Version 2.0
  $ErrorActionPreference = 'Stop'

  $InstallShUrl = 'https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.sh'
  $DockerDocsUrl = 'https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/platforms/docker.md'
  $WindowsDocsUrl = 'https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/platforms/windows.md'

  function Write-BbLine {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer output for a console user.')]
    param([string]$Text = '')
    Write-Host $Text
  }

  # wsl.exe prints UTF-16 unless WSL_UTF8=1 (newer WSL); strip NULs either way.
  # Windows PowerShell 5.1 turns a native command's stderr into error records
  # when it is redirected, and under 'Stop' the first one throws: native
  # calls run with 'Continue' and are judged by $LASTEXITCODE only.
  function Get-BbWslOutput {
    param([string[]]$Arguments)
    $previous = $env:WSL_UTF8
    $env:WSL_UTF8 = '1'
    $ErrorActionPreference = 'Continue'
    $raw = @()
    $code = 1
    try {
      $raw = @(& wsl.exe @Arguments 2>$null)
      $code = $LASTEXITCODE
    } catch {
      $code = 1
    } finally {
      $env:WSL_UTF8 = $previous
    }
    $lines = @()
    foreach ($line in $raw) {
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
    if ($DryRun -and $fake) {
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
    Write-BbLine "  $DockerDocsUrl"
    Write-BbLine "More: $WindowsDocsUrl"
  }

  # A gateway installed natively on Windows (a git clone's `bitterbot
  # gateway install` registers the "Bitterbot Gateway" scheduled task). It
  # holds the gateway port on the Windows side, which WSL's localhost
  # forwarding then cannot use. Detection only: this script never changes it.
  function Get-BbWindowsGateway {
    $fake = $env:BITTERBOT_INSTALL_PS1_FAKE_WINTASK
    if ($DryRun -and $fake) {
      if ($fake -eq 'none') { return @() }
      return @([pscustomobject]@{ TaskName = $fake; State = 'Running' })
    }
    if (-not (Get-Command -Name 'Get-ScheduledTask' -ErrorAction SilentlyContinue)) {
      return @()
    }
    $tasks = @()
    try {
      $tasks = @(Get-ScheduledTask -TaskName 'Bitterbot Gateway*' -ErrorAction SilentlyContinue)
    } catch {
      $tasks = @()
    }
    $found = @()
    foreach ($task in $tasks) {
      if ($null -ne $task) {
        $found += [pscustomobject]@{ TaskName = [string]$task.TaskName; State = [string]$task.State }
      }
    }
    return $found
  }

  function Show-BbWindowsGatewayNote {
    param($Tasks)
    foreach ($task in $Tasks) {
      Write-BbLine "Found a Bitterbot gateway installed natively on Windows: scheduled task '$($task.TaskName)' ($($task.State))."
    }
    Write-BbLine '  It uses the gateway port on Windows, so the WSL install cannot serve it while it runs.'
    Write-BbLine '  This script leaves it alone. To use the WSL install instead (your Windows settings are not moved):'
    foreach ($task in $Tasks) {
      Write-BbLine "    Stop-ScheduledTask -TaskName '$($task.TaskName)'; Disable-ScheduledTask -TaskName '$($task.TaskName)'"
    }
    Write-BbLine '  (Enable-ScheduledTask and Start-ScheduledTask bring it back.)'
    Write-BbLine ''
  }

  function Get-BbInstallCommand {
    param(
      [string]$Pin,
      [bool]$NoOnboardFlag,
      [bool]$YesFlag,
      [bool]$NoSwitchFlag
    )
    $flags = @()
    if ($Pin) {
      if ($Pin -notmatch '^v?\d+\.\d+\.\d+$') {
        throw "-Version must look like 1.6.0 (got '$Pin')"
      }
      $flags += @('--version', ($Pin -replace '^v', ''))
    }
    if ($NoOnboardFlag) { $flags += '--no-onboard' }
    if ($NoSwitchFlag) { $flags += '--no-switch' }
    if ($YesFlag) { $flags += '--yes' }
    $tail = ''
    if ($flags.Count -gt 0) {
      $tail = ' -s -- ' + ($flags -join ' ')
    }
    return "curl -fsSL $InstallShUrl | bash$tail"
  }

  # Pick the WSL2 distribution and print the plan. Returns Code 0 with the
  # target and command, or Code 2 after printing how to get WSL2.
  function Get-BbInstallPlan {
    param([string]$Wanted, [string]$Command)
    $distros = @(Get-BbWslDistro)
    if ($distros.Count -eq 0) {
      Show-BbWslHelp -Reason 'No WSL distribution was found on this machine.'
      return [pscustomobject]@{ Code = 2; Target = $null }
    }
    if ($Wanted) {
      $target = $distros | Where-Object { $_.Name -eq $Wanted } | Select-Object -First 1
      if (-not $target) {
        $names = ($distros | ForEach-Object { $_.Name }) -join ', '
        Show-BbWslHelp -Reason "There is no WSL distribution named '$Wanted' (found: $names)."
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
    Write-BbLine '  Older Bitterbot:   one running inside WSL is switched to the new version (asked once; -NoSwitch leaves it)'
    Write-BbLine ''
    Write-BbLine 'Keep Bitterbot on the Linux filesystem: if you also clone the source, clone it into your'
    Write-BbLine 'Linux home (cd ~ && git clone ...), not under /mnt/c, which is much slower and breaks file watching.'
    Write-BbLine ''
    return [pscustomobject]@{ Code = 0; Target = $target }
  }

  $exitCode = 1
  try {
    $command = Get-BbInstallCommand -Pin $ReleaseVersion -NoOnboardFlag $SkipOnboard -YesFlag $AssumeYes -NoSwitchFlag $SkipSwitch
    $plan = Get-BbInstallPlan -Wanted $DistroName -Command $command
    $exitCode = $plan.Code
    if ($plan.Code -eq 0) {
      $windowsGateway = @(Get-BbWindowsGateway)
      if ($windowsGateway.Count -gt 0) {
        Show-BbWindowsGatewayNote -Tasks $windowsGateway
      }
      $proceed = -not $DryRun
      if ($Cmdlet) {
        $proceed = $Cmdlet.ShouldProcess("WSL2 distribution '$($plan.Target.Name)'", 'Run the Bitterbot Linux installer') -and -not $DryRun
      }
      if (-not $proceed) {
        Write-BbLine 'WhatIf: nothing was run.'
      } else {
        $name = $plan.Target.Name
        $probe = Get-BbWslOutput -Arguments @('-d', $name, '-e', 'sh', '-c', 'command -v curl')
        if ($probe.Code -ne 0) {
          Write-BbLine "curl is missing in '$name'. Install it there first (Ubuntu/Debian: sudo apt-get install -y curl) and run this script again."
          $exitCode = 1
        } else {
          # Not captured: the Linux installer talks to the console directly.
          $ErrorActionPreference = 'Continue'
          & wsl.exe -d $name -e bash -lc $command
          $code = $LASTEXITCODE
          $ErrorActionPreference = 'Stop'
          if ($code -ne 0) {
            Write-BbLine "The Linux installer exited with code $code."
            $exitCode = 1
          } else {
            Write-BbLine ''
            Write-BbLine "Done. In your WSL terminal (wsl -d $name): bitterbot gateway status shows what runs; bitterbot gateway starts it."
            $exitCode = 0
          }
        }
      }
    }
  } catch {
    Write-BbLine "ERROR: $($_.Exception.Message)"
    $exitCode = 1
  }
  if (-not $RunAsFile -and $exitCode -ne 0) {
    Write-BbLine "(installer finished with code $exitCode)"
  }
  $global:LASTEXITCODE = $exitCode
} -ReleaseVersion $Version -DistroName $Distro -SkipOnboard $NoOnboard.IsPresent -AssumeYes $Yes.IsPresent -SkipSwitch $NoSwitch.IsPresent `
  -DryRun ([bool]$WhatIfPreference -or ($env:BITTERBOT_INSTALL_DRY_RUN -eq '1')) `
  -Cmdlet (Get-Variable -Name PSCmdlet -ValueOnly -ErrorAction SilentlyContinue) `
  -RunAsFile ([bool](({ }).File))

# Run as a file (powershell -File, .\install.ps1), report the exit code. A
# script block parsed from a string (irm | iex) has no file: then never
# `exit`, which would close the user's window or end the script that piped
# this into iex. The code is in $LASTEXITCODE.
if (({ }).File) {
  exit $LASTEXITCODE
}
