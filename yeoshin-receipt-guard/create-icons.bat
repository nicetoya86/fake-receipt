@echo off
title Create Icons

echo Creating placeholder icons...

set ICONS_DIR=%~dp0icons
if not exist "%ICONS_DIR%" mkdir "%ICONS_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir='%ICONS_DIR%'; Add-Type -AssemblyName System.Drawing; $c=[System.Drawing.Color]::FromArgb(255,99,102,241); foreach($s in 16,48,128){ $b=New-Object System.Drawing.Bitmap $s,$s; $g=[System.Drawing.Graphics]::FromImage($b); $g.Clear($c); $p=\"$dir\icon$s.png\"; $b.Save($p,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose(); Write-Host \"  OK: icons/icon$s.png\" }"

if %errorlevel% neq 0 (
  echo   ERROR: PowerShell failed. Try running as Administrator.
) else (
  echo.
  echo Done! Reload the extension in chrome://extensions/
)

pause
