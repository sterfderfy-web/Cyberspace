$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = '24.22.2'
$nodeDirectory = Join-Path $projectRoot ".tools\node-v$version-win-x64"
if (-not (Test-Path (Join-Path $nodeDirectory 'node.exe'))) {
    $toolDirectory = Join-Path $projectRoot '.tools'
    New-Item -ItemType Directory -Force $toolDirectory | Out-Null
    $archive = Join-Path $toolDirectory 'node.zip'
    Invoke-WebRequest "https://nodejs.org/dist/v$version/node-v$version-win-x64.zip" -OutFile $archive
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/v$version/SHASUMS256.txt" -UseBasicParsing).Content
    $expected = (($sums -split "`n" | Where-Object { $_ -match " node-v$version-win-x64.zip\s*$" }) -split '\s+')[0]
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'Node.js SHA256 mismatch' }
    Expand-Archive -LiteralPath $archive -DestinationPath $toolDirectory -Force
}
$env:PATH = "$nodeDirectory;" + $env:PATH
Set-Location $projectRoot
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
Write-Host 'Ready: .\scripts\cyberspace.ps1 setup; .\scripts\cyberspace.ps1 start'
