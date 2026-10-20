param(
  [switch]$CheckOnly,
  [string]$Root = 'D:\project\hst\nikou\nikou-magpie',
  [string]$NikouRoot = 'D:\project\hst\nikou\nikou-cli-integration'
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding
$stateRoot = Join-Path $env:LOCALAPPDATA 'NikouMagpie\maintenance'
New-Item -ItemType Directory -Force $stateRoot | Out-Null
$logRoot = Join-Path $stateRoot ('runs\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $logRoot | Out-Null
$mutex = New-Object Threading.Mutex($false, 'Local\NikouMagpieScheduledUpdate')
$held = $false
$utf8 = New-Object Text.UTF8Encoding($false)
try {
  try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
  if (-not $held) { throw '已有维护任务运行，跳过本轮' }
  Set-Location -LiteralPath $Root
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'Never'
  $env:GOROOT = 'D:\project\hst\nikou\.tools\go1.26.8\go'
  $env:PATH = (Join-Path $env:GOROOT 'bin') + ';' + $env:PATH
  $env:NODE_PATH = 'C:\Users\lingpfeng.peng\.agents\skills\playwright-skill\node_modules'
  $env:NIKOU_TEST_SOURCE_DIR = $NikouRoot
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $git = (Get-Command git.exe -ErrorAction Stop).Source
  $codex = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\bin\codex.js'
  if (-not (Test-Path -LiteralPath $codex)) { throw '未找到 Codex CLI，维护任务未执行' }
  $reportPath = Join-Path $logRoot 'upstreams.json'
  $reportOutput = & $node (Join-Path $Root 'company\scripts\integrate.mjs') check-upstreams --root $Root --nikou-dir $NikouRoot --channel stable --json
  if ($LASTEXITCODE -ne 0) { throw '检查上游失败，保留当前安装' }
  $report = ($reportOutput -join "`n") | ConvertFrom-Json
  [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 20), $utf8)
  if ($CheckOnly -or -not $report.changed) {
    $result = @{ status = $(if ($report.changed) { 'updates-available' } else { 'up-to-date' }); checkOnly = [bool]$CheckOnly; report = $reportPath }
  } else {
    foreach ($workspace in @($Root, $NikouRoot)) {
      $changes = & $git -C $workspace status --porcelain --untracked-files=normal
      if ($LASTEXITCODE -ne 0 -or $changes) { throw "工作树存在未提交修改，保留现场：$workspace" }
    }
    $instructions = Get-Content -Raw -Encoding utf8 (Join-Path $Root 'company\scripts\scheduled-update-prompt.md')
    $instructions += "`n本次根目录：$Root`nNikou根目录：$NikouRoot`n本次上游报告：$reportPath`n本次日志目录：$logRoot`n"
    $output = Join-Path $logRoot 'result.json'
    $instructions += "`n将详细结果写入本次日志目录 result.md；最终严格按 JSON Schema 输出状态、中文摘要和证据文件绝对路径。`n"
    # 由 Node 直接传递 UTF-8 字节，避免 PowerShell 管道把中文指令转换成问号。
    [IO.File]::WriteAllText((Join-Path $logRoot 'instructions.md'), $instructions, $utf8)
    [IO.File]::WriteAllText((Join-Path $stateRoot 'latest.json'), (@{status='running'; startedAt=(Get-Date).ToString('o'); summary='AI 正在集成上游并执行验证'; logDirectory=$logRoot} | ConvertTo-Json), $utf8)
    & $node (Join-Path $Root 'company\scripts\run-maintenance-agent.mjs') $Root $logRoot $codex
    $agentExit = $LASTEXITCODE
    if ($agentExit -ne 0) { throw '维护 AI 执行中断（可能是模型路由或网络失败），候选目录已保留；请查看本轮 codex.log 后继续，不能据此认定已安装' }
    $reply = Get-Content -Raw -Encoding utf8 $output | ConvertFrom-Json
    if ($reply.status -notin @('installed', 'up-to-date', 'blocked', 'failed', 'awaiting-maintenance-window')) { throw '维护执行器返回未知状态' }
    if (-not (Test-Path -LiteralPath $reply.evidenceFile -PathType Leaf)) { throw '维护执行器没有生成证据文件' }
    $result = @{ status = $reply.status; summary = $reply.summary; result = $output; report = $reportPath; evidence = $reply.evidenceFile }
  }
  $result.completedAt = (Get-Date).ToString('o')
  [IO.File]::WriteAllText((Join-Path $stateRoot 'latest.json'), ($result | ConvertTo-Json -Depth 10), $utf8)
  $result | ConvertTo-Json
  if ($result.status -in @('failed', 'blocked', 'awaiting-maintenance-window')) { exit 1 }
} catch {
  $result = @{ status = 'failed'; message = $_.Exception.Message; logDirectory = $logRoot; completedAt = (Get-Date).ToString('o') }
  [IO.File]::WriteAllText((Join-Path $stateRoot 'latest.json'), ($result | ConvertTo-Json), $utf8)
  Write-Error $_
  exit 1
} finally {
  if ($held -and -not $CheckOnly -and $node) {
    & $node (Join-Path $Root 'company\scripts\maintenance-notify.mjs') $stateRoot
    if ($LASTEXITCODE -ne 0) { Write-Warning '本轮维护结果已保存，但飞书通知未送达' }
  }
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
