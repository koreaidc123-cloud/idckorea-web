@echo off
title Korea Virtual PC - Registration
rem ---------------------------------------------------------------
rem  IMPORTANT: This file must stay pure ASCII.
rem  cmd.exe reads .bat with the OEM code page (CP949 on Korean
rem  Windows). UTF-8 Korean text turns into garbage and each garbled
rem  line is executed as a command. All Korean lives in the .ps1,
rem  which is UTF-8 with BOM and displays fine.
rem ---------------------------------------------------------------

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kvc-setup.ps1"

if %errorlevel% neq 0 (
  echo.
  echo   [!] Could not start. Please take a photo of this screen.
  echo.
  pause
)
