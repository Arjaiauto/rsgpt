# Dump the LIVE public schema (no data) into the baseline migration.
# Reads SUPABASE_DB_URL from the root .env. The value is never printed or logged.
# Usage (from anywhere):  powershell -File scripts\dump_schema.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) { throw ".env not found at the repo root" }

$url = $null
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*SUPABASE_DB_URL\s*=\s*(.*)$') { $url = $Matches[1].Trim().Trim('"').Trim("'") }
}
if (-not $url) { throw "SUPABASE_DB_URL is not set in .env" }

# A password containing @ : / ? # breaks URL parsing. Split at the LAST @ and percent-encode the password.
if ($url -match '^(postgres(?:ql)?)://([^:/@]+):(.*)@([^@]+)$') {
    $url = "$($Matches[1])://$($Matches[2]):$([uri]::EscapeDataString($Matches[3]))@$($Matches[4])"
}

$dump = Get-Command pg_dump -ErrorAction Stop
$ver = (& $dump.Source --version)
if ($ver -notmatch '(\d+)\.\d+' -or [int]$Matches[1] -lt 17) { throw "pg_dump 17 or higher is required, found: $ver" }

$out = Join-Path $root 'supabase\migrations\20261108000000_baseline.sql'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null

# Schema only, public schema, no owners; privileges (GRANT/REVOKE) are kept on purpose.
# pg_dump's own error text is not shown: it can quote parts of the connection string.
$ErrorActionPreference = 'Continue'   # native stderr must not become a terminating error here
$null = & $dump.Source --schema-only --schema=public --no-owner --dbname=$url --file=$out 2>&1
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE). Check SUPABASE_DB_URL (host, port, user, password) and network access." }
"Wrote $out ($((Get-Item $out).Length) bytes)"
