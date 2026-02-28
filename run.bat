@echo off
REM Usage: run.bat [URL]
REM   URL  - optional kadastr.live URL to open (default hardcoded in script.js)
REM Example:
REM   run.bat "https://kadastr.live/#13.95/46.64265/31.4905"

if "%~1"=="" (
    node script.js
) else (
    node script.js %1
)
