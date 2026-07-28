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

    RESTART ON FAILURE. The task restarts the service if it dies unexpectedly,
    but never if it was stopped on purpose. That distinction is carried by the
    process exit code, not by a flag:

        exit 0    SIGINT/SIGTERM, or `daemon stop`   -> deliberate, no restart
        exit 1    uncaught exception / rejection     -> a crash, restart it

    Task Scheduler's -RestartCount applies only when a task FAILS, so a clean
    shutdown is left alone and `ai-orchestrator daemon stop` does not turn into
    a fight with the scheduler. (An earlier revision of this script omitted
    restart entirely for fear of exactly that fight; the exit-code contract is
    what makes it safe, and daemon.js has honoured it since M1.)

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

# ExecutionTimeLimit Zero: a service runs until stopped, never on a timer.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

# MultipleInstances=IgnoreNew: if the service is somehow already running when
# the trigger fires, do NOT start a second one. Two daemons both claim the
# Telegram long-poll, and getUpdates hands each message to exactly one caller —
# the symptom is a console that answers every other message. The daemon's own
# record refuses a second instance too; this makes the scheduler agree.
$settings.MultipleInstances = 'IgnoreNew'

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
