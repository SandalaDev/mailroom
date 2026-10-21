$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $env:TRIAGE_DATA_DIR) { $env:TRIAGE_DATA_DIR = Join-Path $PSScriptRoot 'data' }
node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'server.mjs') --open
