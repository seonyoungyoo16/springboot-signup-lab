$ErrorActionPreference='Stop'
$signupProject=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $signupProject
$signupRuntime=Join-Path $signupProject '.runtime'
New-Item -ItemType Directory -Path $signupRuntime -Force | Out-Null
function Get-SignupArchive($Url,$File,$Hash){
 if(-not(Test-Path -LiteralPath $File)){Invoke-WebRequest -Uri $Url -OutFile $File}
 if((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $Hash){throw "Archive checksum mismatch: $File"}
}
if(-not(Test-Path -LiteralPath (Join-Path $signupRuntime 'postgres\bin\postgres.exe'))){
 $archive=Join-Path $signupRuntime 'postgres.jar'
 Get-SignupArchive 'https://repo.maven.apache.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/17.11.0/embedded-postgres-binaries-windows-amd64-17.11.0.jar' $archive '98040FAE18DD9633FF95932125B0CECF0A45A1A9312E216E2A33AD03A31D4251'
 New-Item -ItemType Directory -Path (Join-Path $signupRuntime 'pg-archive'),(Join-Path $signupRuntime 'postgres') -Force | Out-Null
 & tar -xf $archive -C (Join-Path $signupRuntime 'pg-archive')
 & tar -xf (Join-Path $signupRuntime 'pg-archive\postgres-windows-x86_64.txz') -C (Join-Path $signupRuntime 'postgres')
 if($LASTEXITCODE -ne 0){throw 'PostgreSQL extraction failed'}
}
if(-not(Test-Path -LiteralPath (Join-Path $signupRuntime 'redis\Redis-7.4.3-Windows-x64-cygwin\redis-server.exe'))){
 $archive=Join-Path $signupRuntime 'redis.zip'
 Get-SignupArchive 'https://github.com/redis-windows/redis-windows/releases/download/7.4.3/Redis-7.4.3-Windows-x64-cygwin.zip' $archive 'F6FE3DBBEA180672FE08CBA80759168EA68A51CD7EE4F097E1B8905A053D0AD1'
 Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $signupRuntime 'redis') -Force
}
if(-not(Test-Path -LiteralPath (Join-Path $signupRuntime 'mailpit\mailpit.exe'))){
 $archive=Join-Path $signupRuntime 'mailpit.zip'
 Get-SignupArchive 'https://github.com/axllent/mailpit/releases/download/v1.31.6/mailpit-windows-amd64.zip' $archive '5d5ad094bfb3bac9004f9d1105d2335fea9f8952c09951df73ae0a280e34d3b1'
 Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $signupRuntime 'mailpit') -Force
}
if(-not(Test-Path -LiteralPath (Join-Path $signupRuntime 'jdk25'))){
 $archive=Join-Path $signupRuntime 'jdk25.zip'
 Get-SignupArchive 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jdk_x64_windows_hotspot_25.0.4.1_1.zip' $archive '00c847d804f4a78e9f04f2683faf14fed898535b177b7fc704486cb0284e9283'
 New-Item -ItemType Directory -Path (Join-Path $signupRuntime 'jdk25') -Force | Out-Null
 Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $signupRuntime 'jdk25') -Force
}
if(-not(Test-Path -LiteralPath (Join-Path $signupRuntime 'keycloak\keycloak-26.8.1\bin\kc.bat'))){
 $archive=Join-Path $signupRuntime 'keycloak.zip'
 Get-SignupArchive 'https://github.com/keycloak/keycloak/releases/download/26.8.1/keycloak-26.8.1.zip' $archive '4cd312c889af358a819a74a6c6f068f9ea159a6959e49924607cec95cfd4c1a4'
 Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $signupRuntime 'keycloak') -Force
}
$signupPgBin=Join-Path $signupRuntime 'postgres\bin'
$signupPgData=Join-Path $signupRuntime 'pg-data'
if(-not(Test-Path -LiteralPath (Join-Path $signupPgData 'PG_VERSION'))){& (Join-Path $signupPgBin 'initdb.exe') -D $signupPgData -U signuplab -A trust --encoding=UTF8 --locale=C;if($LASTEXITCODE -ne 0){throw 'initdb failed'}}
& (Join-Path $signupPgBin 'pg_ctl.exe') -D $signupPgData status *> $null
if($LASTEXITCODE -ne 0){& (Join-Path $signupPgBin 'pg_ctl.exe') -D $signupPgData -l (Join-Path $signupRuntime 'postgres.log') -o '-h 127.0.0.1 -p 55442' -w -t 20 start;if($LASTEXITCODE -ne 0){throw 'PostgreSQL startup failed'}}
if(-not(Get-NetTCPConnection -State Listen -LocalPort 56479 -ErrorAction SilentlyContinue)){
 $data=Join-Path $signupRuntime 'redis-data'
 New-Item -ItemType Directory -Path $data -Force | Out-Null
 $unixPath='/cygdrive/'+$data.Substring(0,1).ToLowerInvariant()+($data.Substring(2).Replace('\','/'))
 Start-Process -FilePath (Join-Path $signupRuntime 'redis\Redis-7.4.3-Windows-x64-cygwin\redis-server.exe') -ArgumentList @('--bind','127.0.0.1','--port','56479','--dir',$unixPath,'--appendonly','yes','--loglevel','warning') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $signupRuntime 'redis.log') -RedirectStandardError (Join-Path $signupRuntime 'redis-error.log')
}
if(-not(Test-Path -LiteralPath (Join-Path $signupRuntime 'dev-key.pem'))){
 $signupOpenSSL='C:\Program Files\Git\usr\bin\openssl.exe'
 if(-not(Test-Path -LiteralPath $signupOpenSSL)){$signupOpenSSL=(Get-Command openssl -ErrorAction Stop).Source}
 & $signupOpenSSL req -x509 -newkey rsa:2048 -nodes -keyout (Join-Path $signupRuntime 'dev-key.pem') -out (Join-Path $signupRuntime 'dev-cert.pem') -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -days 30 *> $null
 if($LASTEXITCODE -ne 0){throw 'HTTPS certificate generation failed'}
}
& node scripts/init-infra.mjs
if($LASTEXITCODE -ne 0){throw 'Infrastructure initialization failed'}
$signupImport=Join-Path $signupRuntime 'keycloak\keycloak-26.8.1\data\import'
New-Item -ItemType Directory -Path $signupImport -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $signupRuntime 'realms') -File | Copy-Item -Destination $signupImport
Write-Output 'Signup PostgreSQL:55442 Redis:56479 infrastructure ready'
