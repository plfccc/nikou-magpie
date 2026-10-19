param([string]$At = '09:00')
$ErrorActionPreference = 'Stop'
if ($At -notmatch '^([01][0-9]|2[0-3]):[0-5][0-9]$') { throw '执行时间须为 HH:mm' }
$taskName = 'NikouMagpie-UpstreamMaintenance'
$runner = Join-Path $PSScriptRoot 'scheduled-update.ps1'
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Arguments -ne $arguments)) {
  throw '同名任务的执行入口不同，保留原任务'
}
$action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.Add([timespan]::Parse($At)))
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '每日检查 Magpie 与公司 GitLab Nikou 上游，隔离合并并验证，成功后发布本机预览包并事务安装；失败保留现状。' -Force | Out-Null
$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{ TaskName = $task.TaskName; State = $task.State.ToString(); NextRunTime = $info.NextRunTime.ToString('o'); TimeZone = (Get-TimeZone).Id; Runner = $runner } | ConvertTo-Json
