# Read-only syntax/ownership tests. Does not execute the launcher's main block.
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'manage-server.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$native = $ast.Find({ param($part) $part -is [Management.Automation.Language.IfStatementAst] -and $part.Extent.Text.StartsWith("if (-not ('PromptMasterLauncher.Native'") }, $false)
if (-not $native) { throw 'Native argv parser definition missing.' }
Invoke-Expression $native.Extent.Text
foreach ($name in @('Get-ProcessArguments', 'Test-SamePath', 'Test-ProjectServer', 'Test-ManagedBrowser')) {
    $definition = $ast.Find({ param($part) $part -is [Management.Automation.Language.FunctionDefinitionAst] -and $part.Name -eq $name }, $false)
    if (-not $definition) { throw ('Definition missing: ' + $name) }
    Invoke-Expression $definition.Extent.Text
}
$nextBin = 'C:\QA with spaces\frontend\node_modules\next\dist\bin\next'
$browserProfile = 'C:\QA with spaces\browser-profile'
$siteUrl = 'http://127.0.0.1:3000/zh-CN/login'
$passed = 0
function Assert-Case([string]$Name, [bool]$Actual, [bool]$Expected) {
    if ($Actual -ne $Expected) { throw ('FAILED: ' + $Name) }
    Write-Host ('PASS: ' + $Name)
    $script:passed++
}
function Node-Command([string]$Line) { return [pscustomobject]@{ Name = 'node.exe'; CommandLine = $Line } }
function Browser-Command([string]$Line) { return [pscustomobject]@{ Name = 'msedge.exe'; CommandLine = $Line } }
$validNode = '"C:\Program Files\nodejs\node.exe" "' + $nextBin + '" dev --hostname 127.0.0.1 --port 3000'
Assert-Case 'quoted exact project argv' (Test-ProjectServer (Node-Command $validNode)) $true
Assert-Case 'unrelated server' (Test-ProjectServer (Node-Command $validNode.Replace('QA with spaces', 'Other project'))) $false
Assert-Case 'path mentioned only as an extra argument' (Test-ProjectServer (Node-Command ('node.exe other.js "' + $nextBin + '" dev --hostname 127.0.0.1 --port 3000'))) $false
Assert-Case 'prefix collision' (Test-ProjectServer (Node-Command $validNode.Replace('bin\next"', 'bin\next-copy"'))) $false
Assert-Case 'other port' (Test-ProjectServer (Node-Command $validNode.Replace('3000', '3001'))) $false
Assert-Case 'public hostname' (Test-ProjectServer (Node-Command $validNode.Replace('127.0.0.1', '0.0.0.0'))) $false
Assert-Case 'missing command line' (Test-ProjectServer (Node-Command '')) $false
Assert-Case 'missing flag value' (Test-ProjectServer (Node-Command $validNode.Replace('3000', ''))) $false
Assert-Case 'wrong executable' (Test-ProjectServer ([pscustomobject]@{Name='other.exe';CommandLine=$validNode})) $false
$validBrowser = 'msedge.exe --app="' + $siteUrl + '" --user-data-dir="' + $browserProfile + '" --no-first-run'
Assert-Case 'managed website window' (Test-ManagedBrowser (Browser-Command $validBrowser)) $true
Assert-Case 'ordinary browser left alone' (Test-ManagedBrowser (Browser-Command ('msedge.exe "' + $siteUrl + '"'))) $false
Assert-Case 'another profile left alone' (Test-ManagedBrowser (Browser-Command $validBrowser.Replace('browser-profile', 'another-profile'))) $false
Assert-Case 'Chromium child not a browser root' (Test-ManagedBrowser (Browser-Command ($validBrowser + ' --type=renderer'))) $false
Assert-Case 'profile substring is not ownership' (Test-ManagedBrowser (Browser-Command $validBrowser.Replace('browser-profile"', 'browser-profile-extra"'))) $false
Assert-Case 'another website app left alone' (Test-ManagedBrowser (Browser-Command $validBrowser.Replace('/zh-CN/login', '/different-app'))) $false
Write-Host ('PASS: Windows PowerShell syntax and ' + $passed + ' ownership cases; no processes or files changed.')
