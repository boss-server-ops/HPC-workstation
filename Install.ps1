param([switch]$NoAutoStart, [switch]$NoLaunch, [switch]$NoShortcuts, [int]$Port = 43127, [int]$StatusPort = 43128)
$ErrorActionPreference = 'Stop'
try {
    if ($Port -lt 1024 -or $Port -gt 65535 -or $StatusPort -lt 1024 -or $StatusPort -gt 65535 -or $Port -eq $StatusPort) { throw 'Choose two different ports between 1024 and 65535.' }
    $taskNode = (Get-Command node.exe -ErrorAction Stop).Source
    $taskMajor = & $taskNode -p "Number(process.versions.node.split('.')[0])"
    $taskArch = & $taskNode -p 'process.arch'
    if ([int]$taskMajor -lt 22 -or $taskArch -notin @('x64', 'arm64')) { throw 'Install the 64-bit Node.js 22 or newer LTS from https://nodejs.org, then retry.' }
    $null = Get-Command ssh.exe -ErrorAction Stop
    $taskNpm = (Get-Command npm.cmd -ErrorAction Stop).Source
    if (Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and ($_.CommandLine.Contains((Join-Path $PSScriptRoot 'supervisor.mjs')) -or $_.CommandLine.Contains((Join-Path $PSScriptRoot 'server.mjs'))) }) { throw 'This installation is running. Use Stop.cmd before reinstalling.' }
    $taskListeners = @()
    try {
        foreach ($taskPort in @($Port, $StatusPort)) {
            $taskListener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $taskPort)
            $taskListener.Start(); $taskListeners += $taskListener
        }
    } catch { throw 'A local port is occupied. Stop the conflicting app or use Install.ps1 -Port 43227 -StatusPort 43228.' }
    finally { foreach ($taskListener in $taskListeners) { $taskListener.Stop() } }
    Push-Location -LiteralPath $PSScriptRoot
    try {
        Write-Host 'Installing locked dependencies from the npm registry...'
        & $taskNpm ci --registry=https://registry.npmjs.org --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the network and rerun Install.cmd.' }
        & $taskNode --input-type=module -e "import pty from 'node-pty'; const p = pty.spawn('cmd.exe',['/d','/c','echo PTY_OK'],{cols:80,rows:24}); let out=''; p.onData(s=>out+=s); p.onExit(e=>process.exit(out.includes('PTY_OK')?0:1)); setTimeout(()=>process.exit(1),8000).unref();"
        if ($LASTEXITCODE -ne 0) { throw 'The Windows terminal component did not pass its startup check.' }
    } finally { Pop-Location }
    $null = New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'data') -Force
    $taskHash = [Security.Cryptography.SHA256]::Create()
    try { $taskId = ([BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 12) } finally { $taskHash.Dispose() }
    $taskRuntime = @{ node = $taskNode; port = $Port; statusPort = $StatusPort; id = $taskId }
    $taskRuntime | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'data/runtime.json') -Encoding UTF8
    $taskShell = New-Object -ComObject WScript.Shell
    $taskLinkName = "HPC Claude Board $taskId.lnk"
    $taskFolders = @()
    if (!$NoShortcuts) { $taskFolders += [Environment]::GetFolderPath('Desktop') }
    if (!$NoAutoStart -and !$NoShortcuts) { $taskFolders += [Environment]::GetFolderPath('Startup') }
    foreach ($taskFolder in $taskFolders) {
        $taskShortcut = $taskShell.CreateShortcut((Join-Path $taskFolder $taskLinkName))
        $taskShortcut.TargetPath = Join-Path $env:WINDIR 'System32/wscript.exe'
        $taskShortcut.Arguments = '"' + (Join-Path $PSScriptRoot 'Run-Board.vbs') + '"'
        if ($taskFolder -eq [Environment]::GetFolderPath('Startup')) { $taskShortcut.Arguments += ' --background' }
        $taskShortcut.WorkingDirectory = $PSScriptRoot
        $taskShortcut.Description = 'Local HPC Claude Board'
        $taskShortcut.Save()
    }
    Write-Host 'Installed. Use the desktop shortcut or Start.cmd. Configure your own server in the browser.'
    if (!$NoLaunch) { Start-Process -FilePath (Join-Path $env:WINDIR 'System32/wscript.exe') -ArgumentList ('"' + (Join-Path $PSScriptRoot 'Run-Board.vbs') + '"') -WindowStyle Hidden }
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; Write-Host 'Requirements: Windows 10/11, Node.js 22+ LTS (including npm), Windows OpenSSH Client.'; exit 1 }
