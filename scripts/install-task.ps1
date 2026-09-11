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

# RepetitionDuration is deliberately absent. [TimeSpan]::MaxValue serialises to
# P99999999DT23H59M59S, which Task Scheduler rejects outright, and omitting the duration is
# what actually means "repeat indefinitely" on Windows 8 and later.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

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

# Register-ScheduledTask reports some failures without terminating, so the only trustworthy
# confirmation is reading the task back. Claiming success without this is how an install
# that silently did nothing goes unnoticed until the queue has sat idle for a day.
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $registered) { throw "$taskName did not register" }

Write-Output "$taskName registered, ticking every 5 minutes"
Write-Output "  node:  $node"
Write-Output "  entry: $entry"
Write-Output ""
Write-Output "Check it with: npm run status"
