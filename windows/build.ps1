# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
# Build, test and publish usagebar into .\publish (both exes side by side).
# Then install from there:   .\publish\usagebar.exe install
param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not $SkipTests) {
    dotnet test tests\UsageBar.Tests -c Release
    if ($LASTEXITCODE -ne 0) { throw "tests failed" }
}

$out = Join-Path $PSScriptRoot 'publish'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
dotnet publish src\UsageBar.Cli -c Release -o $out
if ($LASTEXITCODE -ne 0) { throw "publish (cli) failed" }
dotnet publish src\UsageBar.Tray -c Release -o $out
if ($LASTEXITCODE -ne 0) { throw "publish (tray) failed" }

Write-Host "`nPublished to $out"
Write-Host "Install with: $out\usagebar.exe install"
