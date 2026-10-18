param(
  [Parameter(Mandatory = $true)][string]$NikouDir,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [string]$NpmCli
)

$ErrorActionPreference = 'Stop'
if (-not [System.IO.Path]::IsPathRooted($NikouDir)) { throw 'NikouDir必须为明确的绝对源码路径' }
$entry = Join-Path $PSScriptRoot '../scripts/integrate.mjs'
$common = @('--nikou-dir', $NikouDir)
if ($NpmCli) { $common += @('--npm-cli', $NpmCli) }

& node $entry verify --profile source @common
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node $entry build --platform windows --arch amd64 --version $Version @common
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node $entry verify --profile artifacts @common
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node $entry package --version $Version --nikou-dir $NikouDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output '组合包已生成；真实隔离安装及回滚演练完成前禁止发布。'
