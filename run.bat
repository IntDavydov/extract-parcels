@echo off
REM Usage: run.bat [URL]
REM   URL  - optional kadastrova-karta.com URL to open (default hardcoded in script.js)
REM Example:
REM   run.bat "https://kadastrova-karta.com/#13.95/46.64265/31.4905"

if "%~1"=="" (
    node script.js
) else (
    node script.js %1
)
