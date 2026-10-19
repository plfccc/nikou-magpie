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
    # Windows PowerShell 会把原生命令 stderr 当作错误记录；CLI 的正常进度不应中止任务。
    $ErrorActionPreference = 'Continue'
    try {
      $instructions | & $node $codex exec -C $Root -s danger-full-access -c 'approval_policy="never"' --color never --output-schema (Join-Path $Root 'company\scripts\scheduled-update-result.schema.json') -o $output - *> (Join-Path $logRoot 'codex.log')
      $agentExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = 'Stop' }
    if ($agentExit -ne 0) { throw '自动维护失败，详见本次 codex.log；未将失败标记为成功' }
    $reply = Get-Content -Raw -Encoding utf8 $output | ConvertFrom-Json
    if ($reply.status -notin @('installed', 'up-to-date')) { throw "维护未完成：$($reply.status)：$($reply.summary)；详见 $output" }
    if (-not (Test-Path -LiteralPath $reply.evidenceFile -PathType Leaf)) { throw '维护执行器没有生成证据文件' }
    $result = @{ status = $reply.status; summary = $reply.summary; result = $output; report = $reportPath; evidence = $reply.evidenceFile }
  }
  $result.completedAt = (Get-Date).ToString('o')
  [IO.File]::WriteAllText((Join-Path $stateRoot 'latest.json'), ($result | ConvertTo-Json -Depth 10), $utf8)
  $result | ConvertTo-Json
} catch {
  $result = @{ status = 'failed'; message = $_.Exception.Message; logDirectory = $logRoot; completedAt = (Get-Date).ToString('o') }
  [IO.File]::WriteAllText((Join-Path $stateRoot 'latest.json'), ($result | ConvertTo-Json), $utf8)
  Write-Error $_
  exit 1
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
