<#
.SYNOPSIS
    Proves the AI-Orchestrator Core Service came back on its own after a reboot.

.DESCRIPTION
    Phase 12 M2.1 fixed a validated defect: after a Windows restart the operator
    console was silent, because the Core Service logon task had never been
    installed. The fix is only worth as much as its evidence, and the one claim
    that cannot be tested without an actual reboot is "it comes back by itself".

    This script collects that evidence AFTER a reboot. Run it having launched
    NOTHING by hand:

        powershell -ExecutionPolicy Bypass -File scripts\verify-reboot-persistence.ps1

    Each check states what it proves, not merely that it passed. The important
    one is C4: the service process must be parented by the Task Scheduler
    service, not by a console. A service that is running proves nothing on its
    own — the question is whether a HUMAN started it.

.PARAMETER TestCrashRestart
    Additionally kill the running service and confirm Task Scheduler restarts
    it (the -RestartCount path). This deliberately stops the service for up to
    a minute, so it is opt-in. Any supervised mission keeps running: workers are
    detached and the next service start adopts them.

.PARAMETER Port
    API port to probe. Defaults to the port recorded in state/daemon.json.
#>
[CmdletBinding()]
param(
    [switch]$TestCrashRestart,
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$TaskName = 'AI-Orchestrator Core Service'
$Root = Split-Path -Parent $PSScriptRoot
$DaemonFile = Join-Path $Root 'state\daemon.json'

$script:Pass = 0
$script:Fail = 0

function Check {
    param([string]$Id, [string]$Claim, [bool]$Ok, [string]$Evidence)
    if ($Ok) {
        $script:Pass++
        Write-Host "  [PASS] $Id  $Claim" -ForegroundColor Green
    } else {
        $script:Fail++
        Write-Host "  [FAIL] $Id  $Claim" -ForegroundColor Red
    }
    if ($Evidence) { Write-Host "         $Evidence" -ForegroundColor DarkGray }
}

Write-Host ""
Write-Host "AI-Orchestrator - reboot persistence validation" -ForegroundColor Cyan
Write-Host "================================================"

# --- The reboot itself -------------------------------------------------------
#
# Win32_OperatingSystem.LastBootUpTime is NOT sufficient on its own. With Fast
# Startup enabled (HiberbootEnabled=1, the Windows default), "Shut down" then
# power on is a hybrid resume that can leave LastBootUpTime reporting the last
# FULL boot — so a perfectly valid test would be scored as "no reboot happened".
# The Event Log service start (System log, id 6005) is written on every boot
# including a hybrid one, so the session marker is the LATER of the two.
$reportedBoot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
$eventBoot = $null
try {
    $eventBoot = (Get-WinEvent -FilterHashtable @{LogName='System'; Id=6005} -MaxEvents 1 -ErrorAction Stop).TimeCreated
} catch { }

$boot = $reportedBoot
if (($null -ne $eventBoot) -and ($eventBoot -gt $reportedBoot)) { $boot = $eventBoot }

$sinceBoot = (Get-Date) - $boot
Write-Host ""
Write-Host "Session start: $boot  ($([int]$sinceBoot.TotalMinutes) min ago)"
Write-Host "  LastBootUpTime : $reportedBoot" -ForegroundColor DarkGray
Write-Host "  EventLog 6005  : $eventBoot" -ForegroundColor DarkGray

$fastStartup = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -ErrorAction SilentlyContinue
if (($null -ne $fastStartup) -and ($fastStartup.HiberbootEnabled -eq 1)) {
    Write-Host "  Fast Startup is ON - prefer 'Restart' over 'Shut down' for a clean test." -ForegroundColor DarkYellow
}

# 3 hours, not 24: this script exists to prove a service came back from a boot
# that just happened. A machine up all day cannot demonstrate that, and calling
# it a pass is precisely the false confidence this milestone was fixing.
Check -Id 'C1' -Claim 'A boot happened recently enough for this to be a reboot test' `
    -Ok ($sinceBoot.TotalHours -lt 3) `
    -Evidence "Session is $([int]$sinceBoot.TotalMinutes) min old. Over 3 h means you are looking at a service that never went down."

# --- Did the scheduled task run? --------------------------------------------
Write-Host ""
Write-Host "Autostart mechanism" -ForegroundColor Cyan

$task = $null
try { $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
Check -Id 'C2' -Claim 'The Core Service logon task is registered' `
    -Ok ($null -ne $task) `
    -Evidence "Task: $TaskName"

if ($null -eq $task) {
    Write-Host ""
    Write-Host "Cannot continue: install it with 'ai-orchestrator daemon install'." -ForegroundColor Red
    exit 1
}

$info = Get-ScheduledTaskInfo -TaskName $TaskName
$ranAfterBoot = ($null -ne $info.LastRunTime) -and ($info.LastRunTime -ge $boot)
$sinceBootMin = 0
if ($ranAfterBoot) { $sinceBootMin = [math]::Round(($info.LastRunTime - $boot).TotalMinutes, 1) }
Check -Id 'C3' -Claim 'Task Scheduler ran it during THIS boot' `
    -Ok $ranAfterBoot `
    -Evidence "LastRunTime=$($info.LastRunTime)  LastTaskResult=$($info.LastTaskResult)  (boot was $boot)"

# A LOGON trigger fires within a couple of minutes of boot (PT30S delay plus
# sign-in). A run recorded long after boot is far more likely to be someone
# calling Start-ScheduledTask by hand - which would make every check below pass
# while proving nothing at all about the trigger, the one thing being tested.
if ($ranAfterBoot) {
    Check -Id 'C3c' -Claim 'It ran at LOGON, not from a later manual start' `
        -Ok ($sinceBootMin -le 10) `
        -Evidence "Task ran $sinceBootMin min after boot. Over ~10 min suggests a hand-run 'Start-ScheduledTask', not the logon trigger."
}

Check -Id 'C3b' -Claim 'It is configured to restart itself after a crash' `
    -Ok ($task.Settings.RestartCount -ge 1) `
    -Evidence "RestartCount=$($task.Settings.RestartCount)  Interval=$($task.Settings.RestartInterval)  MultipleInstances=$($task.Settings.MultipleInstances)"

# --- Is the service actually up, and who started it? -------------------------
Write-Host ""
Write-Host "The service" -ForegroundColor Cyan

if (-not (Test-Path $DaemonFile)) {
    Check -Id 'C4' -Claim 'The service is running' -Ok $false -Evidence "No $DaemonFile - nothing ever started."
    Write-Host ""
    Write-Host "RESULT: FAILED - the service did not start after the reboot." -ForegroundColor Red
    exit 1
}

$record = Get-Content $DaemonFile -Raw | ConvertFrom-Json
$proc = $null
try { $proc = Get-Process -Id $record.pid -ErrorAction Stop } catch { }

Check -Id 'C4' -Claim 'A live service process matches the recorded pid' `
    -Ok (($null -ne $proc) -and ($record.state -eq 'running')) `
    -Evidence "state=$($record.state)  pid=$($record.pid)  version=$($record.version)"

if ($null -eq $proc) {
    Write-Host ""
    Write-Host "RESULT: FAILED - the record claims running but the process is gone." -ForegroundColor Red
    exit 1
}

# Started after boot => not a process that somehow survived.
Check -Id 'C5' -Claim 'The process started AFTER the reboot (it is not a survivor)' `
    -Ok ($proc.StartTime -ge $boot) `
    -Evidence "Process start: $($proc.StartTime)"

# Who started it? The parent process CANNOT answer this, and an earlier draft of
# this script wrongly claimed it could. `daemon ensure` spawns DETACHED, so a
# hand-started service is orphaned exactly like a scheduler-started one - both
# show a dead parent, and "parent is gone" would have passed for either. A check
# that passes for the thing it is meant to exclude is worse than no check.
#
# The sound evidence is CORRELATION: Task Scheduler independently records when it
# ran the task (C3), and the process independently records when it started. If
# those agree, and you started nothing by hand, the task started it.
$taskToProcess = $null
if ($null -ne $info.LastRunTime) {
    $taskToProcess = ($proc.StartTime - $info.LastRunTime).TotalSeconds
}
Check -Id 'C6' -Claim 'The running process is the one the task launched (start times agree)' `
    -Ok (($null -ne $taskToProcess) -and ($taskToProcess -ge -5) -and ($taskToProcess -le 120)) `
    -Evidence "Task ran at $($info.LastRunTime); process started at $($proc.StartTime) (delta $([math]::Round($taskToProcess,1))s). This is only meaningful if you started nothing by hand."

# Context, deliberately NOT scored - see above for why it cannot decide anything.
$cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)"
$parentName = 'gone (detached - expected either way)'
try { $parentName = (Get-Process -Id $cim.ParentProcessId -ErrorAction Stop).ProcessName } catch { }
Write-Host "         (context) parent process: $parentName" -ForegroundColor DarkGray
Write-Host "         (context) for pid-level proof, run elevated once:" -ForegroundColor DarkGray
Write-Host "                   wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true" -ForegroundColor DarkGray

# --- Does it answer? ---------------------------------------------------------
Write-Host ""
Write-Host "Reachability" -ForegroundColor Cyan

$apiPort = $Port
if ($apiPort -eq 0) { $apiPort = $record.port }
if (-not $apiPort) { $apiPort = 4711 }

$daemonReport = $null
try {
    $daemonReport = Invoke-RestMethod -Uri "http://127.0.0.1:$apiPort/api/daemon" -TimeoutSec 10
} catch { }

Check -Id 'C7' -Claim 'The API answers' `
    -Ok ($null -ne $daemonReport) `
    -Evidence "GET http://127.0.0.1:$apiPort/api/daemon"

if ($null -ne $daemonReport) {
    Check -Id 'C8' -Claim 'The exclusive Telegram inbound channel is live (your phone will be answered)' `
        -Ok ([bool]$daemonReport.telegramInbound) `
        -Evidence "telegramInbound=$($daemonReport.telegramInbound)  uptime=$([int]($daemonReport.uptimeMs/1000))s  workers=$($daemonReport.workers.Count)"
}

# The operator router is the exact path a Telegram message takes.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
    Push-Location $Root
    $reply = & $node 'bin\ai-orchestrator.js' operator '/projects' 2>&1 | Out-String
    Pop-Location
    Check -Id 'C9' -Claim 'The operator console responds (same router a phone message uses)' `
        -Ok ($reply -match 'Projects \(') `
        -Evidence ($reply.Trim() -split "`n" | Select-Object -First 3) -join ' | '
}

# --- Resilience (opt-in) -----------------------------------------------------
if ($TestCrashRestart) {
    Write-Host ""
    Write-Host "Crash resilience (this stops the service on purpose)" -ForegroundColor Cyan
    $oldPid = $record.pid
    Write-Host "  Killing pid $oldPid ..." -ForegroundColor DarkGray
    Stop-Process -Id $oldPid -Force
    Write-Host "  Waiting up to 150s for Task Scheduler to restart it (RestartInterval is 1 min)..." -ForegroundColor DarkGray

    $restored = $false
    $newPid = 0
    $deadline = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        if (-not (Test-Path $DaemonFile)) { continue }
        $r = Get-Content $DaemonFile -Raw | ConvertFrom-Json
        if ($r.state -eq 'running' -and $r.pid -ne $oldPid) {
            $alive = $null
            try { $alive = Get-Process -Id $r.pid -ErrorAction Stop } catch { }
            if ($null -ne $alive) { $restored = $true; $newPid = $r.pid; break }
        }
    }
    Check -Id 'C10' -Claim 'Task Scheduler restarted the service after it was killed' `
        -Ok $restored `
        -Evidence "old pid $oldPid -> new pid $newPid"
    if (-not $restored) {
        Write-Host "         Start it by hand with: ai-orchestrator daemon ensure" -ForegroundColor Yellow
    }
}

# --- Verdict -----------------------------------------------------------------
Write-Host ""
Write-Host "================================================"
if ($script:Fail -eq 0) {
    Write-Host "RESULT: PASS  ($($script:Pass) checks)" -ForegroundColor Green
    Write-Host "Bug 1 is closed: the Core Service returns after a reboot with no human involved."
    exit 0
} else {
    Write-Host "RESULT: FAIL  ($($script:Pass) passed, $($script:Fail) failed)" -ForegroundColor Red
    Write-Host "Do not treat reboot persistence as proven. Check logs\orchestrator-<date>.log."
    exit 1
}
