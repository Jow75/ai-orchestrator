<#
.SYNOPSIS
    Installs the AI-Orchestrator Core Service auto-start task (Phase 12 M1).

.DESCRIPTION
    Registers a scheduled task that runs `ai-orchestrator serve` when the
    current user logs on, so the Core Service is running before anyone asks
    anything of it:

        Windows boots
          -> user logs on
          -> Task Scheduler runs `ai-orchestrator serve`
          -> the API, the Telegram inbound poll and the scheduler come up
          -> missions still running from before are re-adopted
          -> the phone and the desktop have something to connect to.

    This is deliberately separate from the Phase 2 auto-resume task
    ('AI-Orchestrator Auto-Resume', see install-task.ps1). They answer
    different questions and either can be installed without the other:

        Auto-Resume    "finish the mission the reboot interrupted"
        Core Service   "keep the service available whether or not work is running"

    Installing both is the normal configuration for an always-on machine.

    Note the deliberate absence of -RestartCount: the service's own record
    (state/daemon.json) is what makes a restart safe, and Task Scheduler
    restarting a service that is deliberately stopped would fight the
    operator. Use `ai-orchestrator serve` to start it again by hand.

.PARAMETER InstallRoot
    AI-Orchestrator installation directory (contains bin/ai-orchestrator.js).

.PARAMETER TaskName
    Scheduled task name. Keep the default so the CLI can find it.

.EXAMPLE
    .\install-daemon-task.ps1 -InstallRoot "C:\Users\Admin\Music\AI-Orchestrator"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,

    [Parameter(Mandatory = $false)]
    [string]$Project = '',

    [Parameter(Mandatory = $false)]
    [string]$TaskName = 'AI-Orchestrator Core Service'
)

$ErrorActionPreference = 'Stop'

# Locate node.exe so the task does not depend on PATH at logon time.
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Write-Error 'node.exe not found on PATH. Install Node.js 18+ first.'
    exit 1
}
$nodePath = $nodeCommand.Source

$entryScript = Join-Path $InstallRoot 'bin\ai-orchestrator.js'
if (-not (Test-Path $entryScript)) {
    Write-Error "Cannot find $entryScript. Is -InstallRoot correct?"
    exit 1
}

$arguments = "`"$entryScript`" serve"

$action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument $arguments `
    -WorkingDirectory $InstallRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Let networking settle before the Telegram long-poll makes its first call.
$trigger.Delay = 'PT30S'

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero)   # a service has no time limit

# Replace any previous version of the task.
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Runs the AI-Orchestrator Core Service (API, remote approvals, scheduler, mission workers) at logon.' | Out-Null

Write-Host "Scheduled task '$TaskName' installed." -ForegroundColor Green
Write-Host "  Runs at logon: $nodePath $arguments"
Write-Host "  Verify with:   ai-orchestrator daemon status"
