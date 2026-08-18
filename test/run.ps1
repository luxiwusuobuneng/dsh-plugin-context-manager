# run.ps1 - run the context-manager unit tests (node:test, pure logic only)
#
# Usage:  .\test\run.ps1
#
# Why not `node --test`: node --test spawns one child process per test file and
# captures its output through pipes; in restricted/sandboxed shells the child
# cannot open named pipes (EPERM) and the run fails. This script runs the test
# file directly in the main process instead - equivalent for a single file.
#
# NOTE: the tests import the INSTALLED copies under
# %USERPROFILE%\.dsh\profiles\node_modules (both packages depend on
# @deepseek-ai packages, and the workspace has no node_modules). Run
# .\install.ps1 after changing sources, then run this script.
#
# (ASCII-only on purpose: .ps1 files without a BOM are parsed as ANSI by
# Windows PowerShell, which corrupts non-ASCII text.)

$ErrorActionPreference = "Stop"

$testFile = Join-Path $PSScriptRoot "context-manager.test.mjs"
if (-not (Test-Path $testFile)) {
    Write-Host "[FAIL] test file not found: $testFile" -ForegroundColor Red
    exit 1
}

node $testFile
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] unit tests failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "[OK] all unit tests passed." -ForegroundColor Green
