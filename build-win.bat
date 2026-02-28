@echo off
echo Installing dependencies (no symlinks)...
call npm install --no-bin-links
if errorlevel 1 (echo npm install failed & pause & exit /b 1)

echo Resolving node.exe path...
for /f "delims=" %%i in ('where node') do set NODE_EXE=%%i
echo Using Node: %NODE_EXE%

echo Copying node.exe into package...
if not exist win-node mkdir win-node
copy /y "%NODE_EXE%" win-node\node.exe

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
