@echo off
rem Build model-gateway tray manager. ASCII-only on purpose: cmd.exe parses batch
rem files in the ANSI codepage, so non-ASCII comments/echo break execution.
rem Uses the .NET Framework csc.exe that ships with Windows - no install needed.
rem Output: ..\..\mg-tray.exe (exe stays untracked; only mg-tray.cs is in git).
setlocal
cd /d "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo [ERROR] csc.exe not found under %WINDIR%\Microsoft.NET\Framework*\v4.0.30319
  exit /b 1
)
"%CSC%" /nologo /target:winexe /platform:anycpu /out:"..\..\mg-tray.exe" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll mg-tray.cs
if errorlevel 1 (
  echo [ERROR] build failed
  exit /b 1
)
echo Build OK: mg-tray.exe at project root
