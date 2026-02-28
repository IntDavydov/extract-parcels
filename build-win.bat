@echo off
echo Installing dependencies (no symlinks)...
call npm install --no-bin-links
if errorlevel 1 (echo npm install failed & pause & exit /b 1)

echo Building kadastr.exe...
node node_modules\caxa\build\index.mjs ^
  --input . ^
  --output kadastr.exe ^
  --exclude node_modules\.cache ^
  -- "{{caxa}}\win-node\node.exe" "{{caxa}}\script.js" "{{arg 1}}"

if errorlevel 1 (echo Build failed & pause & exit /b 1)

echo.
echo Done! kadastr.exe is ready.
pause
