<#
.SYNOPSIS
    Removes the AI-Orchestrator auto-resume task from Windows Task Scheduler.

.PARAMETER InstallRoot
    Accepted (and ignored) so the CLI can pass the same arguments to every
    scheduler script.

.PARAMETER TaskName
    Scheduled task name. Keep the default unless you customised the install.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$InstallRoot = '',

    [Parameter(Mandatory = $false)]
    [string]$TaskName = 'AI-Orchestrator Auto-Resume'
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Scheduled task '$TaskName' is not installed; nothing to do."
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Scheduled task '$TaskName' removed." -ForegroundColor Green
