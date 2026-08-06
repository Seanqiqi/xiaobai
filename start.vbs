'==========================================================
'  Digital Museum Launcher (VBS)
'  No dependencies needed - works on any Windows computer
'==========================================================
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Change to script directory
WshShell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)

port = 8080
url = "http://localhost:" & port

' Check if port is already in use
On Error Resume Next
Set testSocket = CreateObject("MSWinsock.Winsock.1")
If Err.Number = 0 Then
    ' Try to bind - if it fails, port is in use
    testSocket.LocalPort = port
    If Err.Number <> 0 Then
        ' Port already in use, server is running
        WScript.Echo "Server is already running. Opening browser..."
        WshShell.Run url
        WScript.Quit
    End If
    testSocket.Close
End If
On Error GoTo 0

' --- Method 1: Python ---
If FindCommand("python") Then
    WScript.Echo "[OK] Found Python. Starting server on port " & port & " ..."
    WScript.Echo "Please visit: " & url
    WScript.Echo "Press Ctrl+C in this window to stop the server."
    WshShell.Run "cmd /c cd /d """ & WshShell.CurrentDirectory & """ && python -m http.server " & port, 1, False
    WScript.Sleep 800
    WshShell.Run url
    WScript.Quit
End If

' --- Method 2: Python3 ---
If FindCommand("python3") Then
    WScript.Echo "[OK] Found Python3. Starting server on port " & port & " ..."
    WScript.Echo "Please visit: " & url
    WScript.Echo "Press Ctrl+C in this window to stop the server."
    WshShell.Run "cmd /c cd /d """ & WshShell.CurrentDirectory & """ && python3 -m http.server " & port, 1, False
    WScript.Sleep 800
    WshShell.Run url
    WScript.Quit
End If

' --- Method 3: Python via common paths ---
paths = Array( _
    "C:\Python314\python.exe", _
    "C:\Python313\python.exe", _
    "C:\Python312\python.exe", _
    "C:\Python311\python.exe", _
    "C:\Python310\python.exe", _
    "C:\Python39\python.exe", _
    "%USERPROFILE%\anaconda3\python.exe", _
    "%USERPROFILE%\miniconda3\python.exe", _
    "%LOCALAPPDATA%\Programs\Python\Python314\python.exe", _
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe", _
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe", _
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe", _
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" _
)

For Each p In paths
    expanded = ExpandEnvironmentVars(p)
    If fso.FileExists(expanded) Then
        WScript.Echo "[OK] Found Python at " & expanded
        WScript.Echo "Starting server on port " & port & " ..."
        WScript.Echo "Please visit: " & url
        WScript.Echo "Press Ctrl+C in this window to stop the server."
        WshShell.Run "cmd /c cd /d """ & WshShell.CurrentDirectory & """ && """ & expanded & """ -m http.server " & port, 1, False
        WScript.Sleep 800
        WshShell.Run url
        WScript.Quit
    End If
Next

' --- Method 4: Node.js (npx) ---
If FindCommand("npx") Then
    WScript.Echo "[OK] Found Node.js. Starting server on port " & port & " ..."
    WScript.Echo "Please visit: " & url
    WScript.Echo "Press Ctrl+C in this window to stop the server."
    WshShell.Run "cmd /c cd /d """ & WshShell.CurrentDirectory & """ && npx http-server -p " & port & " -c-1 --cors", 1, False
    WScript.Sleep 3000
    WshShell.Run url
    WScript.Quit
End If

' --- Method 5: Node.js (node command directly) ---
If FindCommand("node") Then
    WScript.Echo "[OK] Found Node.js. Starting server on port " & port & " ..."
    WScript.Echo "Please visit: " & url
    WScript.Echo "Press Ctrl+C in this window to stop the server."
    ' Create a tiny server script
    serverCode = "const http=require('http'),fs=require('fs'),path=require('path');" & vbCrLf & _
                 "const port=" & port & ";" & vbCrLf & _
                 "const types={'html':'text/html','js':'application/javascript','css':'text/css','json':'application/json','png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','gif':'image/gif','svg':'image/svg+xml','mp4':'video/mp4','mp3':'audio/mpeg','wav':'audio/wav','webp':'image/webp'};" & vbCrLf & _
                 "http.createServer((req,res)=>{" & _
                 "let fp=path.join(__dirname,req.url==='/'?'index.html':decodeURIComponent(req.url));" & _
                 "const ext=path.extname(fp).slice(1).toLowerCase();" & _
                 "fs.readFile(fp,(err,data)=>{" & _
                 "if(err){res.writeHead(404);res.end('Not Found');}" & _
                 "else{res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});res.end(data);}" & _
                 "});" & _
                 "}).listen(port);"
    Set tmpFile = fso.CreateTextFile(fso.BuildPath(fso.GetSpecialFolder(2), "_museum_server.js"), True)
    tmpFile.Write serverCode
    tmpFile.Close
    WshShell.Run "cmd /c node """ & fso.BuildPath(fso.GetSpecialFolder(2), "_museum_server.js") & """", 1, False
    WScript.Sleep 800
    WshShell.Run url
    WScript.Quit
End If

' --- No Python or Node found ---
result = MsgBox( _
    "Python or Node.js was not found on your computer." & vbCrLf & vbCrLf & _
    "Option 1: Install Python (recommended)" & vbCrLf & _
    "  Download: https://www.python.org/downloads/" & vbCrLf & _
    "  IMPORTANT: Check 'Add Python to PATH' during install" & vbCrLf & vbCrLf & _
    "Option 2: Install Node.js" & vbCrLf & _
    "  Download: https://nodejs.org/" & vbCrLf & vbCrLf & _
    vbCrLf & _
    "Option 3: Open the webpage directly" & vbCrLf & _
    "  (Speech recognition may not work with file:// protocol)" & vbCrLf & vbCrLf & _
    "Click YES to open index.html directly," & vbCrLf & _
    "Click NO to exit.", _
    vbYesNo + vbQuestion, _
    "Digital Museum Launcher" _
)

If result = vbYes Then
    WshShell.Run "index.html"
End If

' ========== Helper Functions ==========

Function FindCommand(cmd)
    Set fso = CreateObject("Scripting.FileSystemObject")
    Set shell = CreateObject("WScript.Shell")
    On Error Resume Next
    ' Try where command
    Set exec = shell.Exec("cmd /c where " & cmd & " 2>nul")
    If exec.StdOut.AtEndOfStream <> True Then
        FindCommand = True
    Else
        FindCommand = False
    End If
    On Error GoTo 0
End Function

Function ExpandEnvironmentVars(str)
    Set shell = CreateObject("WScript.Shell")
    ExpandEnvironmentVars = shell.ExpandEnvironmentStrings(str)
End Function
