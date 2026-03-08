@echo off
REM Copyright (c) 2026 Sergei P <spylogsster@gmail.com>
REM This Source Code Form is subject to the terms of the Mozilla Public
REM License, v. 2.0. If a copy of the MPL was not distributed with this
REM file, You can obtain one at https://mozilla.org/MPL/2.0/.
REM
REM Build hnsd from source using MSYS2/MINGW64
REM
REM Prerequisites: MSYS2 installed at C:\msys64
REM   Install MSYS2: choco install msys2 -y
REM
REM This script launches the build inside the MSYS2 MINGW64 shell.

setlocal

REM Try common MSYS2 locations
set MSYS2_PATH=C:\msys64
if exist "%MSYS2_PATH%\usr\bin\bash.exe" goto :found_msys2

set MSYS2_PATH=C:\tools\msys64
if exist "%MSYS2_PATH%\usr\bin\bash.exe" goto :found_msys2

echo.
echo MSYS2 not found at C:\msys64 or C:\tools\msys64
echo.
echo Install MSYS2:
echo   choco install msys2 -y
echo.
echo Or download from https://www.msys2.org
echo.
exit /b 1

:found_msys2
echo Found MSYS2 at %MSYS2_PATH%

REM Get the directory of this script
set SCRIPT_DIR=%~dp0
REM Remove trailing backslash
set SCRIPT_DIR=%SCRIPT_DIR:~0,-1%

REM Convert Windows path to MSYS2 path
set MSYS_SCRIPT_DIR=%SCRIPT_DIR:\=/%
set MSYS_SCRIPT_DIR=%MSYS_SCRIPT_DIR:F:=/f%

echo Building hnsd in MSYS2 MINGW64 shell...
echo Script dir: %MSYS_SCRIPT_DIR%

"%MSYS2_PATH%\msys2_shell.cmd" -mingw64 -defterm -no-start -here -c "cd '%MSYS_SCRIPT_DIR%' && bash build_hnsd.sh"

if %ERRORLEVEL% neq 0 (
    echo Build failed!
    exit /b 1
)

echo.
echo Build complete. Binary at: %SCRIPT_DIR%\bin\hnsd.exe
