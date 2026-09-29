# ─────────────────────────────────────────────────────────────
# Print Agent — Windows Uninstall Script
# Stops the agent and removes the Scheduled Task.
# ─────────────────────────────────────────────────────────────

$TaskName = "PrintAgent"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "  Print Agent — Uninstall"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($task) {
    Stop-ScheduledTask  -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "✓ Print Agent stopped and removed."
    Write-Host ""
    Write-Host "Note: The script files in this folder were NOT deleted."
    Write-Host "      You can remove them manually if you no longer need them."
} else {
    Write-Host "No scheduled task named '$TaskName' was found."
    Write-Host "Nothing to remove."
}

Write-Host ""
