# Windows PowerShell 5.1 compatible; keep this source ASCII for double-click use.
[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Status',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$frontend = Join-Path $projectRoot 'frontend'
$nextBin = Join-Path $frontend 'node_modules\next\dist\bin\next'
$siteUrl = 'http://127.0.0.1:3000/zh-CN/login'
$stateRoot = Join-Path $env:LOCALAPPDATA 'PromptMasterAI'
$clusterPath = Join-Path $stateRoot 'postgres-data'
$hashProvider = [Security.Cryptography.SHA256]::Create()
try { $projectHash = ([BitConverter]::ToString($hashProvider.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 16) }
finally { $hashProvider.Dispose() }
$launcherDir = Join-Path $stateRoot ('launchers\' + $projectHash)
$statePath = Join-Path $launcherDir 'service.json'
$browserProfile = Join-Path $launcherDir 'browser-profile'
$mutex = New-Object Threading.Mutex($false, ('Local\PromptMasterAI-' + $projectHash))
$locked = $false
$exitCode = 0
$databaseHealthMode = 'database'

# Parse Windows argv exactly; never treat a substring, stale PID or process name
# alone as authority to stop a process. Browser UI is scoped to its own profile.
if (-not ('PromptMasterLauncher.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace PromptMasterLauncher {
    public static class Native {
        [DllImport("shell32.dll", SetLastError = true)]
        static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int argc);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
        public static string[] Split(string command) {
            int count; var pointer = CommandLineToArgvW(command, out count);
            if (pointer == IntPtr.Zero) throw new InvalidOperationException("Cannot inspect process arguments.");
            try {
                var result = new string[count];
                for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size));
                return result;
            } finally { LocalFree(pointer); }
        }
    }
}
'@
}

function Get-ProcessArguments($Candidate) {
    if (-not $Candidate.CommandLine) { return @() }
    return [PromptMasterLauncher.Native]::Split([string]$Candidate.CommandLine)
}
function Test-SamePath([string]$Left, [string]$Right) {
    if (-not $Left -or -not $Right) { return $false }
    try { return [IO.Path]::GetFullPath($Left).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Right).TrimEnd('\') }
    catch { return $false }
}
function Test-ProjectServer($Candidate) {
    if ($Candidate.Name -ine 'node.exe') { return $false }
    $arguments = @(Get-ProcessArguments $Candidate)
    if ($arguments.Count -lt 7 -or -not (Test-SamePath $arguments[1] $nextBin) -or $arguments[2] -ne 'dev') { return $false }
    $portIndex = [Array]::IndexOf($arguments, '--port')
    $hostIndex = [Array]::IndexOf($arguments, '--hostname')
    return $portIndex -ge 0 -and $hostIndex -ge 0 -and $portIndex + 1 -lt $arguments.Count -and $hostIndex + 1 -lt $arguments.Count -and $arguments[$portIndex + 1] -eq '3000' -and $arguments[$hostIndex + 1] -eq '127.0.0.1'
}
function Get-ProjectServers {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { Test-ProjectServer $_ })
}
function Test-ManagedBrowser($Candidate) {
    if ($Candidate.Name -notin @('msedge.exe', 'chrome.exe')) { return $false }
    $arguments = @(Get-ProcessArguments $Candidate)
    # Chromium child processes do not own the app window and lack --app.
    return $arguments -icontains ('--user-data-dir=' + $browserProfile) -and $arguments -icontains ('--app=' + $siteUrl) -and -not ($arguments | Where-Object { $_ -like '--type=*' })
}
function Get-ManagedBrowsers {
    return @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { Test-ManagedBrowser $_ })
}
function Test-Port([int]$Port) {
    $connection = New-Object Net.Sockets.TcpClient
    try {
        $result = $connection.BeginConnect('127.0.0.1', $Port, $null, $null)
        return $result.AsyncWaitHandle.WaitOne(500) -and $connection.Connected
    } catch { return $false }
    finally { $connection.Close() }
}
function Test-Website {
    $response = $null
    try {
        $request = [Net.HttpWebRequest]::Create($siteUrl)
        $request.Proxy = $null
        $request.Timeout = 3500
        $request.ReadWriteTimeout = 3500
        $request.AllowAutoRedirect = $false
        $response = $request.GetResponse()
        return [int]$response.StatusCode -eq 200
    } catch { return $false }
    finally { if ($response) { $response.Close() } }
}
function Assert-WebsiteOwner($Server) {
    # Some Windows CIM providers mislabel the State enum. A listening socket has
    # no remote endpoint; HTTP readiness has already proved that it accepts TCP.
    $listeners = @(Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 0 -and $_.OwningProcess -gt 0 })
    if ($listeners.Count -eq 0) { throw 'Cannot verify the website listening process. No browser was opened.' }
    foreach ($listener in $listeners) {
        $processIdToCheck = [int]$listener.OwningProcess
        $owned = $false
        for ($depth = 0; $depth -lt 12 -and $processIdToCheck -gt 0; $depth++) {
            $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $processIdToCheck) -ErrorAction SilentlyContinue
            if (-not $candidate -or $candidate.CreationDate -lt $Server.CreationDate) { break }
            if ($candidate.ProcessId -eq $Server.ProcessId -and $candidate.CreationDate -eq $Server.CreationDate -and (Test-ProjectServer $candidate)) { $owned = $true; break }
            $processIdToCheck = [int]$candidate.ParentProcessId
        }
        if (-not $owned) { throw 'Port 3000 is not owned by this project server. No browser was opened or unrelated process stopped.' }
    }
}
function Get-Node {
    # Prefer the installed Node.js over tool-specific/older copies on PATH.
    $candidates = @()
    $installed = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path -LiteralPath $installed) { $candidates += $installed }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command -and $command.Source -and ($candidates -notcontains $command.Source)) {
        $candidates += $command.Source
    }
    foreach ($candidate in $candidates) {
        try {
            $version = (& $candidate --version 2>$null | Out-String).Trim()
            if ($version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { return $candidate }
        } catch { }
    }
    throw 'Node.js 22 or newer is required. Install the current Node.js LTS, then try again.'
}
function Invoke-Health([string]$Mode) {
    Push-Location -LiteralPath $frontend
    try {
        & $script:node '--env-file=.env.local' 'scripts/service-health.mjs' $Mode
        if ($LASTEXITCODE -ne 0) { throw ('Project database readiness failed (' + $Mode + '). Check .env.local and the local database; no password is printed.') }
    } finally { Pop-Location }
}
function Invoke-Migrations {
    Push-Location -LiteralPath $frontend
    try {
        # Keep the console clean on routine starts; show native errors on failure.
        & $script:node '--env-file=.env.local' 'scripts/migrate.mjs' | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'Database migration failed. The existing database was not replaced; review the error above.'
        }
        Write-Host 'Database schema is up to date.'
    } finally { Pop-Location }
}
function Get-PgCtl {
    $versionPath = Join-Path $clusterPath 'PG_VERSION'
    if (-not (Test-Path -LiteralPath $versionPath)) { throw 'Existing project database cluster is missing. This launcher never initializes or replaces data.' }
    $major = (Get-Content -LiteralPath $versionPath -Raw).Trim()
    if ($major -notmatch '^\d{1,2}$') { throw 'Invalid project PostgreSQL version.' }
    $candidate = Join-Path $env:ProgramFiles ('PostgreSQL\' + $major + '\bin\pg_ctl.exe')
    if (-not (Test-Path -LiteralPath $candidate)) { throw ('PostgreSQL tools not found for cluster version ' + $major) }
    return $candidate
}
function Test-ClusterRunning([string]$Tool) {
    & $Tool status -D $clusterPath *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
    if ($LASTEXITCODE -eq 3) { return $false }
    throw 'Cannot verify the existing project PostgreSQL cluster. No database was changed.'
}
function Assert-ClusterConfiguration([string]$Tool) {
    $postgres = Join-Path (Split-Path -Parent $Tool) 'postgres.exe'
    $configuredPort = & $postgres -D $clusterPath -C port
    if ($LASTEXITCODE -ne 0 -or "$configuredPort".Trim() -ne '55432') { throw 'Project database must use its reserved port 55432.' }
    $addresses = & $postgres -D $clusterPath -C listen_addresses
    if ($LASTEXITCODE -ne 0 -or -not "$addresses".Trim()) { throw 'Cannot verify project database listen addresses.' }
    foreach ($address in "$addresses".Split(',')) {
        if ($address.Trim() -notin @('127.0.0.1', 'localhost', '::1')) { throw 'Refusing to start a non-loopback database.' }
    }
}
function Start-ProjectDatabase {
    $startupLog = Join-Path $stateRoot 'postgres-startup.log'
    $tool = $null
    try { $tool = Get-PgCtl } catch { }
    if ($tool -and (Test-ClusterRunning $tool)) {
        $script:databaseHealthMode = 'database'
        Write-Host 'Using the existing project PostgreSQL database.'
        Invoke-Health 'database'
        return
    }
    if (Test-Port 55432) {
        # Another process may be the project database from a different Windows
        # user/package context. Accept it only after verifying the project schema.
        Write-Host 'Port 55432 is already serving a database; verifying that it is this project...'
        Invoke-Health 'database-existing'
        $script:databaseHealthMode = 'database-existing'
        Write-Host 'Using the already-running project database on port 55432.'
        return
    }
    if (-not $tool) { $tool = Get-PgCtl }
    Assert-ClusterConfiguration $tool
    # Nothing is listening on 55432 at this point, so an existing pid file can only
    # be left over from an interrupted shutdown and would block pg_ctl start.
    $stalePid = Join-Path $clusterPath 'postmaster.pid'
    if (Test-Path -LiteralPath $stalePid) {
        Write-Host 'Removing a stale PostgreSQL pid file from an interrupted shutdown...'
        Remove-Item -LiteralPath $stalePid -Force
    }
    Write-Host 'Starting the existing project PostgreSQL database...'
    & $tool start -D $clusterPath -l $startupLog -w -t 25
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'PostgreSQL startup log (tail):'
        Get-Content -LiteralPath $startupLog -Tail 12 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
        throw ('Database startup failed. The existing data directory was not deleted. See ' + $startupLog)
    }
    Invoke-Health 'database'
}
function Stop-ValidatedTree($Original, [string]$Kind) {
    $fresh = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$Original.ProcessId) -ErrorAction SilentlyContinue
    if (-not $fresh) { return }
    if ($fresh.CreationDate -ne $Original.CreationDate) { throw 'Process identity changed. Refusing to stop a reused PID.' }
    $valid = if ($Kind -eq 'Server') { Test-ProjectServer $fresh } else { Test-ManagedBrowser $fresh }
    if (-not $valid) { throw 'Process no longer belongs to this launcher. Nothing was stopped.' }
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID ([int]$fresh.ProcessId) /T /F *> $null
    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id ([int]$fresh.ProcessId) -ErrorAction SilentlyContinue)) { throw ('Could not stop the project ' + $Kind + ' process.') }
}
function Open-ProjectWebsite {
    foreach ($candidate in @(Get-ManagedBrowsers)) {
        $window = Get-Process -Id ([int]$candidate.ProcessId) -ErrorAction SilentlyContinue
        if ($window -and $window.MainWindowHandle -ne [IntPtr]::Zero) {
            [void][PromptMasterLauncher.Native]::ShowWindowAsync($window.MainWindowHandle, 9)
            [void][PromptMasterLauncher.Native]::SetForegroundWindow($window.MainWindowHandle)
            Write-Host 'Focused the existing project website window.'
            return
        }
    }
    $browsers = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    $browser = $browsers | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $browser) {
        Write-Warning ('Server is ready. Edge/Chrome was not found; open manually: ' + $siteUrl)
        return
    }
    $browserArguments = '--app="{0}" --user-data-dir="{1}" --no-first-run --no-default-browser-check --disable-background-mode' -f $siteUrl, $browserProfile
    Start-Process -FilePath $browser -ArgumentList $browserArguments -WindowStyle Normal | Out-Null
    Write-Host 'Opened the project website in its own browser window/profile.'
}
function Close-ProjectWebsite {
    $windows = @(Get-ManagedBrowsers)
    foreach ($candidate in $windows) {
        $window = Get-Process -Id ([int]$candidate.ProcessId) -ErrorAction SilentlyContinue
        if ($window) { [void]$window.CloseMainWindow() }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $remaining = @(Get-ManagedBrowsers)
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    foreach ($candidate in $remaining) { Stop-ValidatedTree $candidate 'Browser' }
}
function Save-ServiceState($Server) {
    [ordered]@{
        SchemaVersion = 2; ProjectRoot = $projectRoot; Port = 3000; Url = $siteUrl
        ProcessId = [int]$Server.ProcessId; ProcessCreatedAt = $Server.CreationDate.ToUniversalTime().ToString('o')
        DatabaseDirectory = $clusterPath; BrowserProfile = $browserProfile; CheckedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Normalize-ProcessEnvironment {
    # Windows PowerShell 5.1 builds a case-insensitive environment dictionary when
    # starting a child process. If the parent block contains both HTTPS_PROXY and
    # https_proxy, Start-Process throws "An item with the same key has already been
    # added" and the website never starts. Rewriting each proxy name collapses the
    # duplicate case variants to one canonical entry.
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}
try {
    Normalize-ProcessEnvironment
    try { $locked = $mutex.WaitOne(1000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another project start/stop is in progress. Wait for it to finish, then retry.' }
    if ($Action -eq 'Start') {
        $script:node = Get-Node
        if (-not (Test-Path -LiteralPath $nextBin)) { throw 'Next.js dependencies are missing. Run npm install in frontend first.' }
        Invoke-Health 'config'
        $databaseHealthMode = 'database'
        $servers = @(Get-ProjectServers)
        if ($servers.Count -gt 1) { throw 'Multiple project servers found. Use Stop before starting again.' }
        if ((Test-Port 3000) -and $servers.Count -eq 0) { throw 'Port 3000 belongs to another process. No process was stopped and no browser was opened.' }
        New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
        Start-ProjectDatabase
        Invoke-Migrations
        if ($servers.Count -eq 0) {
            $runStamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff')
            $stdoutPath = Join-Path $launcherDir ('server-' + $runStamp + '.log')
            $stderrPath = Join-Path $launcherDir ('server-' + $runStamp + '-error.log')
            $arguments = '"{0}" dev --hostname 127.0.0.1 --port 3000' -f $nextBin
            $started = Start-Process -FilePath $script:node -ArgumentList $arguments -WorkingDirectory $frontend -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
            Write-Host ('Starting project website (PID ' + $started.Id + ')...')
            $server = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $started.Id)
            if (-not (Test-ProjectServer $server)) { throw 'Could not validate the launched project process.' }
            Save-ServiceState $server
        } else {
            $server = $servers[0]
            Write-Host 'Project website process is already running; checking readiness...'
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(55)
        $ready = $false
        do {
            if (Test-Website) { $ready = $true; break }
            $live = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$server.ProcessId) -ErrorAction SilentlyContinue
            if (-not $live -or $live.CreationDate -ne $server.CreationDate) { throw ('Website process exited. See logs: ' + $launcherDir) }
            Start-Sleep -Milliseconds 400
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $ready) { throw ('Website readiness timed out. No browser opened. Keep logs for diagnosis: ' + $launcherDir) }
        Assert-WebsiteOwner $server
        Invoke-Health $databaseHealthMode
        Save-ServiceState $server
        Write-Host ('READY: ' + $siteUrl)
        if (-not $NoBrowser) { Open-ProjectWebsite }
    } elseif ($Action -eq 'Stop') {
        # Never trust the old global service.json PID; discover and revalidate exact argv.
        Close-ProjectWebsite
        foreach ($server in @(Get-ProjectServers)) { Stop-ValidatedTree $server 'Server' }
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (@(Get-ProjectServers).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
        if (@(Get-ProjectServers).Count -gt 0) { throw 'Project website did not stop. Database left running for diagnosis.' }
        $tool = Get-PgCtl
        if (Test-ClusterRunning $tool) {
            Write-Host 'Stopping only the project PostgreSQL cluster; data is retained...'
            & $tool stop -D $clusterPath -m fast -w -t 25
            if ($LASTEXITCODE -ne 0) { throw 'Project database shutdown failed. No database files were removed.' }
        }
        if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
        if (Test-Port 3000) { Write-Warning 'Port 3000 is used by another process; it was left untouched.' }
        Write-Host 'STOPPED: project website/window and project database. Other browsers/services are untouched.'
    } else {
        $servers = @(Get-ProjectServers)
        Write-Host ('Project server processes: ' + $servers.Count)
        Write-Host ('Project browser windows/processes: ' + @(Get-ManagedBrowsers).Count)
        Write-Host ('Website ready: ' + (Test-Website))
        $tool = Get-PgCtl
        Write-Host ('Project database running: ' + (Test-ClusterRunning $tool))
        Write-Host ('Logs/state: ' + $launcherDir)
    }
} catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $exitCode
