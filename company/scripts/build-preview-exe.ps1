# 预览版也必须生成 Windows 资源，避免任务栏和快捷方式退回默认程序图标。
param([string]$Version = '')
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot)
if (!$Version) { $Version = (Get-Content (Join-Path $repo 'company/version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw '版本必须为 x.y.z' }
Push-Location $repo
try {
    rtk proxy go run github.com/tc-hib/go-winres@v0.3.3 make --in build/windows/winres.json --arch amd64 --out rsrc --file-version $Version --product-version $Version
    if ($LASTEXITCODE -ne 0) { throw 'Windows 图标资源生成失败' }
    rtk proxy go build -buildvcs=false -tags production -trimpath "-ldflags=-s -w -X main.version=$Version -X github.com/yetone/magpie/internal/update.CompanyMode=1 -H windowsgui" -o artifacts/company/preview/nikou-magpie-preview.exe .
    if ($LASTEXITCODE -ne 0) { throw 'Windows EXE 构建失败' }
} finally { Pop-Location }
