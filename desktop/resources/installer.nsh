!macro customInstall
  ; Kill any running Bitterbot processes before installing
  nsExec::ExecToLog 'taskkill /F /IM Bitterbot.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM bitterbot-orchestrator.exe /T'

  ; Wait for processes to fully terminate
  Sleep 2000

  ; Clean up old app data so fresh config is always used on upgrade
  RMDir /r "$APPDATA\bitterbot-desktop"
!macroend

!macro customUnInstall
  ; Kill any running Bitterbot processes
  nsExec::ExecToLog 'taskkill /F /IM Bitterbot.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM bitterbot-orchestrator.exe /T'
  Sleep 2000

  ; Clean up app data
  RMDir /r "$APPDATA\bitterbot-desktop"

  ; Ask user if they want to remove workspace data (memories, personality, etc.)
  MessageBox MB_YESNO "Remove Bitterbot workspace data (memories, personality, skills)?$\n$\nThis will delete: $PROFILE\.bitterbot" IDNO SkipWorkspace
    RMDir /r "$PROFILE\.bitterbot"
  SkipWorkspace:
!macroend
