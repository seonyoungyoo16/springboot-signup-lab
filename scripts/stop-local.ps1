param([switch]$KeepInfra)
$ErrorActionPreference='Stop'
$signupRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$signupRuntime=Join-Path $signupRoot '.runtime'
$signupMeta=Join-Path $signupRuntime 'processes.json'
if(Test-Path -LiteralPath $signupMeta){$meta=Get-Content -LiteralPath $signupMeta -Raw|ConvertFrom-Json;if($meta.root -eq $signupRoot){$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$meta.gateway);if($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'scripts[\\/]gateway\.mjs' -and [Math]::Abs((([datetime]$meta.startedAt).ToUniversalTime()-$p.CreationDate.ToUniversalTime()).TotalSeconds) -lt 120){Stop-Process -Id $p.ProcessId -ErrorAction SilentlyContinue}}}
$signupApps=Get-CimInstance Win32_Process -Filter "name = 'java.exe'" | Where-Object {$_.CommandLine -and ($_.CommandLine.Contains((Join-Path $signupRuntime 'app-')) -or (-not $KeepInfra -and $_.CommandLine.Contains($signupRuntime)))}
foreach($p in $signupApps){Stop-Process -Id $p.ProcessId -ErrorAction SilentlyContinue}
if(-not $KeepInfra){
 $mailpit=Get-CimInstance Win32_Process -Filter "name = 'mailpit.exe'" | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($signupRuntime,[StringComparison]::OrdinalIgnoreCase)}
 foreach($p in $mailpit){Stop-Process -Id $p.ProcessId -ErrorAction SilentlyContinue}
 $redisOwner=Get-NetTCPConnection -State Listen -LocalPort 56479 -ErrorAction SilentlyContinue | Select-Object -First 1
 if($redisOwner){$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$redisOwner.OwningProcess);if($p.ExecutablePath -and $p.ExecutablePath.StartsWith($signupRuntime+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){& (Join-Path $signupRuntime 'redis\Redis-7.4.3-Windows-x64-cygwin\redis-cli.exe') -p 56479 SHUTDOWN SAVE}}
 if(Test-Path -LiteralPath (Join-Path $signupRuntime 'pg-data\postmaster.pid')){& (Join-Path $signupRuntime 'postgres\bin\pg_ctl.exe') -D (Join-Path $signupRuntime 'pg-data') -m fast -w -t 15 stop}
}
Write-Output 'Owned signup processes stopped. Project data retained.'
