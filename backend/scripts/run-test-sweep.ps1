<#
.SYNOPSIS
  Creates a disposable local PostgreSQL database, runs the migrations, boots the
  API against it and executes the safe test scripts, saving results to a CSV.

.DESCRIPTION
  This sweep targets a LOCAL scratch database only (default umodzi_test on
  localhost). It refuses to run against any other host. It never touches the
  live backend/.env and never contacts Supabase: dotenv does not override
  variables that are already present in the process environment, so the scratch
  connection strings exported here win over anything in backend/.env.

  Scripts that rewrite backend/.env, perform Supabase role maintenance, probe
  the live pooler, or require an external Gemini key are EXCLUDED and are
  recorded in the CSV with the reason, so the omission is visible rather than
  silent.

.PARAMETER PgPassword
  Mandatory. The local postgres superuser password. Never hardcoded, never
  written to disk; used only to build in-memory connection strings.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File backend\scripts\run-test-sweep.ps1 -PgPassword 'secret'
#>
param(
  [Parameter(Mandatory = $true)][string]$PgPassword,
  [string]$PgUser = 'postgres',
  [string]$PgHost = 'localhost',
  [int]$PgPort = 5432,
  [string]$DbName = 'umodzi_test',
  [int]$ApiPort = 3001,
  [string]$AdminEmail = 'sweep-admin@umodzi.local',
  [string]$AdminPassword = '',
  [string]$CsvPath = ''
)

$ErrorActionPreference = 'Stop'
$PSQL = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'

# --- hard safety guard: scratch database on this machine only ---------------
if ($PgHost -notin @('localhost', '127.0.0.1', '::1')) {
  throw "Refusing to run: PgHost '$PgHost' is not localhost. This sweep only targets a local scratch database."
}
if (-not (Test-Path $PSQL)) { throw "psql not found at $PSQL" }

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # repo root
if ([string]::IsNullOrEmpty($CsvPath)) { $CsvPath = Join-Path $root 'docs\test-results.csv' }

$enc = [System.Uri]::EscapeDataString($PgPassword)
$scratchUrl = "postgresql://${PgUser}:${enc}@${PgHost}:${PgPort}/${DbName}"

function Invoke-Psql([string]$Database, [string]$Sql) {
  $env:PGPASSWORD = $PgPassword
  & $PSQL -U $PgUser -h $PgHost -p $PgPort -d $Database -v ON_ERROR_STOP=1 -qtA -c $Sql
  if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE) on database '$Database'" }
}

function Test-PortFree([int]$port) {
  try {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
    $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}

$results = [System.Collections.Generic.List[object]]::new()
function Add-Result([string]$suite, [string]$script, [string]$status, [string]$passed, [string]$failed, [int]$exit, [string]$notes) {
  $results.Add([pscustomobject]@{
      Suite = $suite; Script = $script; Status = $status
      Passed = $passed; Failed = $failed; ExitCode = $exit; Notes = $notes
    })
}

Write-Host "== Umodzi test sweep against local scratch database '$DbName' =="

# --- 1. create the scratch database if absent -------------------------------
$exists = Invoke-Psql 'postgres' "SELECT 1 FROM pg_database WHERE datname='$DbName'"
if ([string]::IsNullOrWhiteSpace($exists)) {
  Write-Host "creating database $DbName ..."
  Invoke-Psql 'postgres' "CREATE DATABASE $DbName"
} else {
  Write-Host "database $DbName already present; reusing it"
}

# --- 2. run the twelve migrations as superuser ------------------------------
$env:MIGRATIONS_DATABASE_URL = $scratchUrl
$env:DATABASE_URL = $scratchUrl
Write-Host 'running migrations ...'
$migrate_out = npm run migrate -w backend 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "migrations failed:`n$migrate_out" }

Write-Host 'post-migration checks:'
Invoke-Psql $DbName 'SELECT postgis_version()'
Invoke-Psql $DbName "SELECT count(*) || ' public tables' FROM information_schema.tables WHERE table_schema='public'"
Invoke-Psql $DbName "SELECT count(*) || ' accepted-offer guard indexes' FROM pg_indexes WHERE indexname LIKE '%accepted%'"
Invoke-Psql $DbName "SELECT count(*) || ' RLS policies' FROM pg_policies"

# --- 3. boot the API against the scratch database on a free port ------------
if (-not (Test-PortFree $ApiPort)) {
  throw "Port $ApiPort is already in use. Stop the other backend first: the sweep must own port $ApiPort so tests can never reach a live server."
}
if ([string]::IsNullOrEmpty($AdminPassword)) {
  $AdminPassword = 'Sweep-' + [guid]::NewGuid().ToString('N').Substring(0, 12) + 'a1'
}
$env:PORT = "$ApiPort"
$env:DATABASE_URL = $scratchUrl
$env:JWT_SECRET = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
$env:FRONTEND_ORIGIN = 'http://localhost:3000'
$env:NODE_ENV = 'development'

$serverLog = Join-Path $env:TEMP 'umodzi-sweep-server.log'
$serverErr = Join-Path $env:TEMP 'umodzi-sweep-server.err.log'
$server = Start-Process -FilePath 'npm' -ArgumentList 'run', 'dev', '-w', 'backend' `
  -WorkingDirectory $root -NoNewWindow -PassThru `
  -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr

$healthy = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$ApiPort/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
  } catch { }
}
if (-not $healthy) {
  taskkill /T /F /PID $server.Id | Out-Null
  throw "backend did not become healthy on port $ApiPort; see $serverLog / $serverErr"
}
Write-Host "backend healthy on port $ApiPort"

# --- 4. best-effort scratch administrator for suites that need one ----------
try {
  $body = @{ email = $AdminEmail; password = $AdminPassword; firstName = 'Sweep'; lastName = 'Admin'; role = 'customer' } | ConvertTo-Json
  Invoke-RestMethod -Uri "http://localhost:$ApiPort/api/v1/auth/register" -Method Post -Body $body -ContentType 'application/json' | Out-Null
} catch { Write-Host "note: admin registration skipped ($($_.Exception.Message)) - account may already exist" }
try {
  Invoke-Psql $DbName "UPDATE users SET role='administrator' WHERE email='$AdminEmail'" | Out-Null
  $env:ADMIN_EMAIL = $AdminEmail
  $env:ADMIN_PASSWORD = $AdminPassword
  Write-Host "scratch administrator ready: $AdminEmail"
} catch { Write-Host 'note: could not promote scratch administrator; suites needing one will report it' }

# --- 5. run the safe scripts -------------------------------------------------
# Schema-inspection suites run last, per the runbook.
$backendScripts = @(
  'storage-tests.ts', 'task23-tests.ts', 'task33-classify-tests.ts',
  'task23-migration-tests.ts', 'task25-api-tests.ts', 'task26-api-tests.ts', 'task27-api-tests.ts',
  'task28-3-privacy-tests.ts', 'task28-3a1-location-privacy-tests.ts', 'task28-event-notification-tests.ts',
  'task28-offer-notification-tests.ts', 'task28-offer-outcome-tests.ts', 'task28-push-delivery-tests.ts',
  'task28-push-e2e-tests.ts', 'task28-push-subscriptions-tests.ts', 'task28-request-status-notification-tests.ts',
  'task28-sms-tests.ts', 'task28-verification-notification-tests.ts',
  'task331-chat-e2e-tests.ts', 'task332-admin-privacy-tests.ts', 'task333-realtime-tests.ts', 'task334-push-contact-tests.ts',
  'task23-api-tests.ts', 'verify-28-3a-docs.ts', 'task352-radius-predicate-check.ts', 'task352-runtime-sanity.ts',
  'task351-rls-audit.ts', 'task352-final-integrity-check.ts'
)
$frontendScripts = @(
  'task22-tests.ts', 'task26-tests.ts', 'task27-tests.ts', 'task28-3-privacy-tests.ts',
  'task28-3a1-location-privacy-tests.ts', 'task28-push-tests.ts', 'task29-refresh-tests.ts',
  'task30-audit-helper-checks.ts', 'task31-request-validation-checks.ts', 'task32-legal-checks.ts'
)
$excluded = @(
  @{ n = 'task352-retire-service-key.ts';      why = 'not a test: rewrites backend/.env' },
  @{ n = 'task352-switch-connection.ts';       why = 'rewrites backend/.env connection strings' },
  @{ n = 'task352-create-runtime-role.ts';     why = 'writes APP_DATABASE_URL into backend/.env' },
  @{ n = 'task352-set-search-path.ts';         why = 'Supabase role maintenance, targets live database' },
  @{ n = 'task352-grant-extensions-usage.ts';  why = 'Supabase role maintenance, targets live database' },
  @{ n = 'task352-tls-probe.ts';               why = 'probes the live Supabase pooler and writes a cert file' },
  @{ n = 'task352-searchpath-debug.ts';        why = 'interactive debug probe for the live connection' },
  @{ n = 'task33-gemini-smoke.mjs';            why = 'requires an external Gemini API key' }
)

function Run-Suite([string]$suite, [string]$name) {
  Write-Host "-- $suite/$name"
  $out = & npx --no-install tsx "scripts/$name" 2>&1 | Out-String
  $code = $LASTEXITCODE
  $pm = [regex]::Matches($out, '(\d+)\s+passed') | Select-Object -Last 1
  $fm = [regex]::Matches($out, '(\d+)\s+failed') | Select-Object -Last 1
  $passed = if ($pm) { $pm.Groups[1].Value } else { '' }
  $failed = if ($fm) { $fm.Groups[1].Value } else { '' }
  $status = if ($code -eq 0) { 'PASS' } else { 'FAIL' }
  Add-Result $suite $name $status $passed $failed $code ''
  if ($code -ne 0) { Write-Host $out }
}

Push-Location (Join-Path $root 'backend')
foreach ($s in $backendScripts) { Run-Suite 'backend' $s }
Pop-Location
Push-Location (Join-Path $root 'frontend')
foreach ($s in $frontendScripts) { Run-Suite 'frontend' $s }
Pop-Location
foreach ($e in $excluded) { Add-Result 'backend' $e.n 'EXCLUDED' '' '' 0 $e.why }

# --- 6. stop the scratch backend and write the CSV --------------------------
taskkill /T /F /PID $server.Id | Out-Null
$results | Export-Csv -Path $CsvPath -NoTypeInformation

$pass = @($results | Where-Object Status -eq 'PASS').Count
$fail = @($results | Where-Object Status -eq 'FAIL').Count
Write-Host "== sweep complete: $pass passed, $fail failed, $($excluded.Count) excluded =="
Write-Host "results: $CsvPath"
if ($fail -gt 0) { exit 1 }
