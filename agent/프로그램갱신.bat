@echo off
title Korea Virtual PC - Agent Update
rem ---------------------------------------------------------------
rem  IMPORTANT: This file must stay pure ASCII.
rem  cmd.exe reads .bat with the OEM code page (CP949 on Korean
rem  Windows). All Korean lives in the .ps1 (UTF-8 with BOM).
rem ---------------------------------------------------------------

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kvc-update.ps1"

if %errorlevel% neq 0 (
  echo.
  echo   [!] Could not start. Please take a photo of this screen.
  echo.
  pause
)
