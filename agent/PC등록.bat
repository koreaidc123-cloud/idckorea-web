@echo off
chcp 65001 >nul
title 한국 가상컴 - PC 등록

rem ═══════════════════════════════════════════════════════════
rem  한국 가상컴 — 현장 PC 등록
rem  USB 를 꽂고 이 파일을 두 번 누르시면 됩니다.
rem
rem  관리자 권한이 필요해서, 한 번 물어보는 창이 뜹니다.
rem  [예] 를 눌러 주세요.
rem ═══════════════════════════════════════════════════════════

rem 관리자 권한인지 확인하고, 아니면 관리자로 다시 실행합니다
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   관리자 권한으로 다시 시작합니다.
  echo   [예] 를 눌러 주세요.
  echo.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kvc-setup.ps1"

if %errorlevel% neq 0 (
  echo.
  echo   문제가 생겼습니다. 사진을 찍어서 보내 주세요.
  echo.
  pause
)
