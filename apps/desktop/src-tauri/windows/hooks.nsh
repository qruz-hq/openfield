; A running server sidecar locks its .exe, so an update or reinstall could not replace it.
; Stop it before files are copied. Openfield itself is closed by the installer as usual.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM openfield-server.exe'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM openfield-server.exe'
!macroend
