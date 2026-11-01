param([ValidateSet('setup','start','dev','dev:web','agent','check','build','test','test:browser')][string]$Command = 'start')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$nodeDirectory = Join-Path $projectRoot '.tools\node-v24.22.2-win-x64'
if (Test-Path (Join-Path $nodeDirectory 'node.exe')) { $env:PATH = "$nodeDirectory;" + $env:PATH }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Run scripts/bootstrap.ps1 first' }
Set-Location $projectRoot
& npm.cmd run $Command
exit $LASTEXITCODE
