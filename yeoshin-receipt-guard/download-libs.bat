@echo off
title Yeoshin Receipt Guard - Download Libraries

if not exist "lib" mkdir lib
if not exist "lang" mkdir lang
if not exist "icons" mkdir icons

echo.
echo [1/4] Downloading Tesseract.js v4.1.4...
curl -L "https://cdn.jsdelivr.net/npm/tesseract.js@4.1.4/dist/tesseract.min.js" -o "lib/tesseract.min.js"
if %errorlevel% neq 0 ( echo   ERROR: tesseract.min.js failed ) else ( echo   OK: lib/tesseract.min.js )

echo.
echo [2/4] Downloading Tesseract Worker v4.1.4...
curl -L "https://cdn.jsdelivr.net/npm/tesseract.js@4.1.4/dist/worker.min.js" -o "lib/tesseract-worker.min.js"
if %errorlevel% neq 0 ( echo   ERROR: worker.min.js failed ) else ( echo   OK: lib/tesseract-worker.min.js )

echo.
echo [3/4] Downloading exif-js v2.3.0...
curl -L "https://cdn.jsdelivr.net/npm/exif-js@2.3.0/exif.js" -o "lib/exif.js"
if %errorlevel% neq 0 ( echo   ERROR: exif.js failed ) else ( echo   OK: lib/exif.js )

echo.
echo [4/4] Downloading Korean OCR data (approx 10MB)...
curl -L "https://tessdata.projectnaptha.com/4.0.0/kor.traineddata.gz" -o "lang/kor.traineddata.gz"
if %errorlevel% neq 0 ( echo   ERROR: kor.traineddata.gz failed ) else ( echo   OK: lang/kor.traineddata.gz )

echo.
echo ============================================
echo  blockhash.js - already bundled in lib/
echo  No download needed.
echo ============================================
echo.
echo All downloads complete!
echo Next: Load this folder in chrome://extensions/
echo ============================================
pause
