<#
.SYNOPSIS
    Installs the AI-Orchestrator auto-resume task in Windows Task Scheduler.

.DESCRIPTION
    Registers a scheduled task that runs `ai-orchestrator resume` when the
    current user logs on. Combined with the orchestrator's heartbeat and
    session records this closes the reboot-recovery loop:

        Windows reboots mid-mission
          -> user logs on
          -> Task Scheduler runs `ai-orchestrator resume`
          -> the orchestrator finds the interrupted session
          -> the mission continues exactly where it stopped.

    `resume` exits quietly when nothing was interrupted, so the task is
    always safe to fire.

.PARAMETER InstallRoot
    AI-Orchestrator installation directory (contains bin/ai-orchestrator.js).

.PARAMETER Project
    Optional project name for the resume command. When omitted, the
    orchestrator resumes the project recorded in its last heartbeat.

.PARAMETER TaskName
    Scheduled task name. Keep the default so the CLI can find it.

.EXAMPLE
    .\install-task.ps1 -InstallRoot "C:\Users\Admin\Music\AI-Orchestrator"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,

    [Parameter(Mandatory = $false)]
    [string]$Project = '',

    [Parameter(Mandatory = $false)]
    [string]$TaskName = 'AI-Orchestrator Auto-Resume'
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

$arguments = "`"$entryScript`" resume"
if ($Project) {
    $arguments = "$arguments `"$Project`""
}

$action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument $arguments `
    -WorkingDirectory $InstallRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Give Windows a moment to bring up networking before the agent starts.
$trigger.Delay = 'PT30S'

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)   # missions may run for days

# Replace any previous version of the task.
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Resumes interrupted AI-Orchestrator missions after logon/reboot.' | Out-Null

Write-Host "Scheduled task '$TaskName' installed." -ForegroundColor Green
Write-Host "  Runs at logon: $nodePath $arguments"
Write-Host "  Verify with:   ai-orchestrator scheduler status"
