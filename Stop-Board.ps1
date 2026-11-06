param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
try {
    $taskSupervisorPath = Join-Path $PSScriptRoot 'supervisor.mjs'
    $taskWorkerPath = Join-Path $PSScriptRoot 'server.mjs'
    $taskProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($taskSupervisorPath) -or $_.CommandLine.Contains($taskWorkerPath)) })
    # Snapshot identities, then stop only the supervisor and workers for this exact directory.
    foreach ($taskRole in @($taskSupervisorPath, $taskWorkerPath)) {
        foreach ($taskProcess in $taskProcesses | Where-Object { $_.CommandLine.Contains($taskRole) }) {
            $taskCurrent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $taskProcess.ProcessId)
            if ($taskCurrent -and $taskCurrent.CreationDate -eq $taskProcess.CreationDate -and $taskCurrent.CommandLine -eq $taskProcess.CommandLine) { Stop-Process -Id $taskProcess.ProcessId -Force -ErrorAction SilentlyContinue }
        }
    }
    if ($Uninstall) {
        $taskRuntime = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'data/runtime.json') | ConvertFrom-Json
        if ($taskRuntime.id -notmatch '^[0-9A-F]{12}$') { throw 'Invalid installation identity.' }
        $taskShell = New-Object -ComObject WScript.Shell
        foreach ($taskFolder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'))) {
            $taskLink = Join-Path $taskFolder ("HPC Claude Board " + $taskRuntime.id + '.lnk')
            if (Test-Path -LiteralPath $taskLink) {
                $taskShortcut = $taskShell.CreateShortcut($taskLink)
                if ($taskShortcut.Arguments.StartsWith('"' + (Join-Path $PSScriptRoot 'Run-Board.vbs') + '"')) { Remove-Item -LiteralPath $taskLink }
            }
        }
        Write-Host 'Removed startup and desktop shortcuts. Local data and all remote sessions are retained.'
    } else { Write-Host 'This local board is stopped. Remote tmux/Claude sessions are retained. Start.cmd opens it again.' }
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
