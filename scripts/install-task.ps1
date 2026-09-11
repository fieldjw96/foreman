# Registers the scheduled task that ticks foreman every five minutes.
# Usage: .\scripts\install-task.ps1  [-Unregister]
#
# Runs only on the server laptop. JACK_LAPTOP has no scheduled task by design.

param([switch]$Unregister)

$ErrorActionPreference = "Stop"
$taskName = "foreman-tick"

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "$taskName removed"
    exit 0
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $repoRoot "src\index.ts"
if (-not (Test-Path $entry)) { throw "cannot find $entry" }

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`" tick" -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

# A tick takes seconds, so the old four-hour execution limit is gone. Ten minutes is far
# longer than a healthy tick and short enough that a wedged one clears itself.
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "foreman: claims status:ready Tickets and launches detached Runs" -Force | Out-Null

Write-Output "$taskName registered, ticking every 5 minutes"
Write-Output "  node:  $node"
Write-Output "  entry: $entry"
Write-Output ""
Write-Output "Check it with: npm run status"
