# install.ps1 - 把 context-manager 两个包同步到运行实例的 profiles\node_modules
#
# 用法:  .\install.ps1
# 注意:  同步完成后必须重启 DSH，Service/Agent 代码才会生效（浏览器刷新页面即可看到新 UI）。
# 注意:  本文件必须保持 UTF-8 带 BOM 编码；Windows PowerShell 5.1 会把无 BOM 的
#        .ps1 按 ANSI(GBK) 解析，中文注释/字符串会导致解析失败。

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$profileNodeModules = Join-Path $env:USERPROFILE ".dsh\profiles\node_modules"

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
    if (-not (Test-Path $target)) {
        Write-Host "[SKIP] $($pkg.Name): 未安装到 $target（请先安装/接线，见 README）" -ForegroundColor Yellow
        continue
    }
    Copy-Item -Path (Join-Path $pkg.Source "*") -Destination $target -Recurse -Force
    Write-Host "[OK]   $($pkg.Name) -> $target" -ForegroundColor Green
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  同步完成。请【重启 DSH】使 Service/Agent 新代码生效。" -ForegroundColor Cyan
Write-Host "  （浏览器端 UI 刷新页面即可；客户端 bundle 每次请求都从磁盘读取）" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
