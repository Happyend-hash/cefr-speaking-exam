@echo off
rem Applies the newest update file Claude put in "Claude outputs", then
rem sends it to GitHub with push-update.bat. Just double-click this file.
cd /d "%~dp0"

rem A window opened from Explorer may not know where git is yet if it was
rem installed recently, so fall back to git's standard install folder.
where git >nul 2>&1 || set "PATH=%PATH%;C:\Program Files\Git\cmd"

set "latest="
for /f "delims=" %%f in ('dir /b /o-d "Claude outputs\*.bundle" 2^>nul') do if not defined latest set "latest=%%f"

if not defined latest (
  echo No update file found in the "Claude outputs" folder.
  pause
  exit /b 1
)

echo Applying %latest% ...
echo.
git pull --ff-only "Claude outputs\%latest%" main
if errorlevel 1 (
  echo.
  echo The update could not be applied. Send Claude a screenshot of this window.
  pause
  exit /b 1
)

echo.
call push-update.bat
