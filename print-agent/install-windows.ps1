# ─────────────────────────────────────────────────────────────
# Print Agent — Windows Install Script
# Registers the agent as a Scheduled Task so it starts
# automatically when you log in (runs silently in background).
# ─────────────────────────────────────────────────────────────
# Run in PowerShell as your normal user (no admin needed).
# Right-click → "Run with PowerShell" or open PowerShell and run:
#   .\install-windows.ps1
# ─────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$TaskName   = "PrintAgent"
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptPath = Join-Path $ScriptDir "print-agent-windows.py"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "  Print Agent — Windows Setup"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Host "Script location : $ScriptPath"
Write-Host "Scheduled Task  : $TaskName"
Write-Host ""

# ── Locate pythonw.exe (runs Python without a console window) ──
$PythonW = $null
$candidates = @(
    (Get-Command pythonw -ErrorAction SilentlyContinue)?.Source,
    (Get-Command python  -ErrorAction SilentlyContinue)?.Source -replace "python\.exe$", "pythonw.exe"
)
foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $PythonW = $c; break }
}

if (-not $PythonW) {
    Write-Host "ERROR: Could not find pythonw.exe. Make sure Python 3 is installed."
    Write-Host "Download from: https://www.python.org/downloads/"
    Write-Host "Make sure 'Add Python to PATH' is checked during install."
    exit 1
}

Write-Host "Python found    : $PythonW"
Write-Host ""

# ── Remove any existing task with the same name ──
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# ── Create the Scheduled Task ──
$Action  = New-ScheduledTaskAction -Execute $PythonW -Argument "`"$ScriptPath`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action   $Action `
    -Trigger  $Trigger `
    -Settings $Settings `
    -Description "Local PDF print agent HTTP server (port 9191)" | Out-Null

# ── Start it immediately ──
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 2

Write-Host "✓ Print Agent installed and started!"
Write-Host ""
Write-Host "It will start automatically every time you log in."
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "  Quick test commands"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Host "  Check health:"
Write-Host "    curl http://127.0.0.1:9191/health"
Write-Host ""
Write-Host "  List printers:"
Write-Host "    curl http://127.0.0.1:9191/printers"
Write-Host ""
Write-Host "  Print a PDF:"
Write-Host "    curl -X POST http://127.0.0.1:9191/print ``"
Write-Host "         -H 'Content-Type: application/pdf' ``"
Write-Host "         --data-binary @C:\path\to\file.pdf"
Write-Host ""
Write-Host "  To uninstall, run: .\uninstall-windows.ps1"
Write-Host ""
