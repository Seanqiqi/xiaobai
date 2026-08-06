@echo off
chcp 65001 >nul
title Digital Museum Launcher

echo ============================================
echo   Digital Museum - Starting...
echo ============================================
echo.

cd /d "%~dp0"

REM Fix line endings: if this file has LF-only line endings,
REM CMD might not parse it correctly. Try to fix and re-run.
if not "%~1"=="__fixed__" (
    findstr /c:"" "%~f0" >nul 2>&1
    if errorlevel 1 (
        echo [INFO] Detected non-standard line endings. Attempting to fix...
        powershell -Command "$content = [System.IO.File]::ReadAllText('%~f0'); $content = $content -replace '(?<!\r)\n', "`r`n"; [System.IO.File]::WriteAllText('%~f0', $content)"
        start "" cmd /c ""%~f0" __fixed__"
        exit /b
    )
)

echo [INFO] Trying to start local web server on port 8080...
echo.

REM Method 1: Python (python command)
where python >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Found Python. Starting server...
    echo.
    echo Please open your browser and visit: http://localhost:8080
    echo Press Ctrl+C to stop the server.
    echo.
    start "" "http://localhost:8080"
    python -m http.server 8080
    goto :end
)

REM Method 2: Python3
where python3 >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Found Python3. Starting server...
    echo.
    echo Please open your browser and visit: http://localhost:8080
    echo Press Ctrl+C to stop the server.
    echo.
    start "" "http://localhost:8080"
    python3 -m http.server 8080
    goto :end
)

REM Method 3: Python via full path (common Anaconda/Miniconda paths)
if exist "%USERPROFILE%\anaconda3\python.exe" (
    echo [OK] Found Anaconda Python. Starting server...
    echo.
    echo Please open your browser and visit: http://localhost:8080
    echo Press Ctrl+C to stop the server.
    echo.
    start "" "http://localhost:8080"
    "%USERPROFILE%\anaconda3\python.exe" -m http.server 8080
    goto :end
)

if exist "%USERPROFILE%\miniconda3\python.exe" (
    echo [OK] Found Miniconda Python. Starting server...
    echo.
    echo Please open your browser and visit: http://localhost:8080
    echo Press Ctrl+C to stop the server.
    echo.
    start "" "http://localhost:8080"
    "%USERPROFILE%\miniconda3\python.exe" -m http.server 8080
    goto :end
)

REM Method 4: Node.js
where npx >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Found Node.js. Starting server...
    echo.
    echo Please open your browser and visit: http://localhost:8080
    echo Press Ctrl+C to stop the server.
    echo.
    start "" "http://localhost:8080"
    npx http-server -p 8080 -c-1 --cors
    goto :end
)

REM Method 5: Node.js (node command directly)
where node >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Found Node.js. Starting server...
    echo.
    echo Please open your browser and visit: http://localhost:8080
    echo Press Ctrl+C to stop the server.
    echo.
    start "" "http://localhost:8080"
    node -e "const http=require('http'),fs=require('fs'),path=require('path');const port=8080;const m={'html':'text/html','js':'application/javascript','css':'text/css','json':'application/json','png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','gif':'image/gif','svg':'image/svg+xml','mp4':'video/mp4'};http.createServer((req,res)=>{let fp=path.join(__dirname,req.url==='/'?'index.html':decodeURIComponent(req.url));const ext=path.extname(fp).slice(1).toLowerCase();fs.readFile(fp,(err,data)=>{if(err){res.writeHead(404);res.end('Not Found');}else{res.writeHead(200,{'Content-Type':m[ext]||'application/octet-stream'});res.end(data);}});}).listen(port);"
    goto :end
)

REM No Python or Node.js found
echo [WARNING] Python or Node.js not found on this computer.
echo.
echo   Option 1: Install Python (recommended)
echo     Download from: https://www.python.org/downloads/
echo     IMPORTANT: Check "Add Python to PATH" during installation
echo.
echo   Option 2: Install Node.js
echo     Download from: https://nodejs.org/
echo.
echo   Option 3: Try start.vbs (VBScript launcher, no CRLF issues)
echo.
echo   Option 4: Open index.html directly
echo     (Speech recognition may not work with file:// protocol)
echo.
choice /c 1234 /m "Choose an option"
if %errorlevel% equ 1 start "" "https://www.python.org/downloads/"
if %errorlevel% equ 2 start "" "https://nodejs.org/"
if %errorlevel% equ 3 if exist "start.vbs" wscript "start.vbs"
if %errorlevel% equ 4 start "" "index.html"
goto :end

:end
