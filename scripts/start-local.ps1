param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$signupRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $signupRoot
if(Get-NetTCPConnection -State Listen -LocalPort 8470 -ErrorAction SilentlyContinue){throw 'Signup lab is already running; stop the owned gateway before rebuilding.'}
if(-not(Test-Path -LiteralPath node_modules)){& npm ci;if($LASTEXITCODE -ne 0){throw 'npm ci failed'}}
& (Join-Path $PSScriptRoot 'setup-local.ps1')
if(-not $SkipBuild){& npm run build;if($LASTEXITCODE -ne 0){throw 'Frontend build failed'};& (Join-Path $PSScriptRoot 'maven.ps1') -q -f backend/pom.xml package;if($LASTEXITCODE -ne 0){throw 'Backend build failed'}}
& node scripts/gateway.mjs
