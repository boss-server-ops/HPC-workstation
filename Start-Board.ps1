param([switch]$Background)
$ErrorActionPreference = 'Stop'
try {
    $taskRuntime = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'data/runtime.json') | ConvertFrom-Json
    if (!(Test-Path -LiteralPath $taskRuntime.node -PathType Leaf)) { throw 'Node.js moved or was removed. Run Install.cmd again.' }
    $taskBoardUrl = 'http://127.0.0.1:' + [int]$taskRuntime.port
    $taskStatusUrl = 'http://127.0.0.1:' + [int]$taskRuntime.statusPort + '/status'
    $taskSupervisorPath = Join-Path $PSScriptRoot 'supervisor.mjs'
    $taskWorkerPath = Join-Path $PSScriptRoot 'server.mjs'
    function Get-OwnedStatus {
        try { $taskStatus = Invoke-RestMethod -Uri $taskStatusUrl -TimeoutSec 2 } catch { return $null }
        $taskProcess = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$taskStatus.pid)
        if ($taskStatus.app -ne 'hpc-board-supervisor' -or !$taskProcess -or !$taskProcess.CommandLine.Contains($taskSupervisorPath)) { throw 'The status port belongs to another installation. Choose different ports in Install.ps1.' }
        return $taskStatus
    }
    $taskStatus = Get-OwnedStatus
    if (!$taskStatus) {
        $env:HPC_BOARD_PORT = [string]$taskRuntime.port
        $env:HPC_BOARD_STATUS_PORT = [string]$taskRuntime.statusPort
        Start-Process -FilePath $taskRuntime.node -ArgumentList ('"' + $taskSupervisorPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    }
    $taskReady = $false
    for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
        $taskStatus = Get-OwnedStatus
        if ($taskStatus -and $taskStatus.health -eq 'port-conflict') { throw 'The board port is occupied by another app. Choose different ports in Install.ps1.' }
        if ($taskStatus -and $taskStatus.health -eq 'ready') {
            $taskHealth = Invoke-RestMethod -Uri ($taskBoardUrl + '/api/health') -TimeoutSec 2
            $taskWorker = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$taskHealth.pid)
            if ($taskHealth.pid -ne $taskStatus.workerPid -or !$taskWorker -or !$taskWorker.CommandLine.Contains($taskWorkerPath)) { throw 'This port belongs to another board. Choose different ports in Install.ps1.' }
            $taskReady = $true; break
        }
        Start-Sleep -Milliseconds 500
    }
    if (!$taskReady) { throw 'The local board did not start. Check data/server-error.log and data/supervisor.log.' }
    if (!$Background) { Start-Process $taskBoardUrl }
} catch {
    $taskMessage = $_.Exception.Message + "`nIf this is the first run, use Install.cmd first."
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'data')) { $taskMessage | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'data/launcher-error.log') }
    if (!$Background) { $taskShell = New-Object -ComObject WScript.Shell; $null = $taskShell.Popup($taskMessage, 0, 'HPC Claude Board', 16) }
    exit 1
}
