# install.ps1 - 把 context-manager 两个包同步到运行实例的 profiles\node_modules
#
# 用法:  .\install.ps1
# 注意:  同步完成后必须重启 DSH，Service/Agent 代码才会生效（浏览器刷新页面即可看到新 UI）。
# 注意:  本文件必须保持 UTF-8 带 BOM 编码；Windows PowerShell 5.1 会把无 BOM 的
#        .ps1 按 ANSI(GBK) 解析，中文注释/字符串会导致解析失败。

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$dshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profileNodeModules = Join-Path $dshRoot "profiles\node_modules"
$failed = $false
New-Item -ItemType Directory -Path $profileNodeModules -Force | Out-Null

$pairs = @(
    @{
        Name   = "dsh-context-manager-service-luxi"
        Source = (Join-Path $root "dsh-context-manager-service-luxi")
    },
    @{
        Name   = "dsh-context-manager-agent-luxi"
        Source = (Join-Path $root "dsh-context-manager-agent-luxi")
    },
    @{
        Name   = "dsh-context-manager-ui-luxi"
        Source = (Join-Path $root "dsh-context-manager-ui-luxi")
    }
)

foreach ($pkg in $pairs) {
    $target = Join-Path $profileNodeModules $pkg.Name
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    if (-not (Test-Path (Join-Path $pkg.Source "package.json"))) {
        Write-Host "[FAIL] $($pkg.Name): 源目录缺少 package.json" -ForegroundColor Red
        $failed = $true
        continue
    }
    Copy-Item -Path (Join-Path $pkg.Source "*") -Destination $target -Recurse -Force
    if (Test-Path (Join-Path $target "package.json")) {
        Write-Host "[OK]   $($pkg.Name) -> $target" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] $($pkg.Name): 复制后未找到 package.json" -ForegroundColor Red
        $failed = $true
    }
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
if ($failed) {
    Write-Host "  同步未完成：至少一个包复制失败。" -ForegroundColor Red
    exit 1
}
Write-Host "  三个包同步完成。请【重启 DSH】使 Service/Agent 新代码生效。" -ForegroundColor Cyan
Write-Host "  （浏览器端 UI 刷新页面即可；客户端 bundle 每次请求都从磁盘读取）" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
