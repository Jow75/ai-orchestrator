<#
.SYNOPSIS
    Removes the AI-Orchestrator Core Service auto-start task (Phase 12 M1).

.DESCRIPTION
    Only removes the logon task. A Core Service that is running right now
    keeps running — stop it with `ai-orchestrator daemon stop`.

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
    [string]$Project = '',

    [Parameter(Mandatory = $false)]
    [string]$TaskName = 'AI-Orchestrator Core Service'
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Scheduled task '$TaskName' is not installed; nothing to do."
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Scheduled task '$TaskName' removed." -ForegroundColor Green
# ASCII only in console output: the PowerShell host here renders non-ASCII
# punctuation as mojibake (matches the convention in install-task.ps1).
Write-Host 'A Core Service that is running right now is unaffected. Stop it with "ai-orchestrator daemon stop".'
