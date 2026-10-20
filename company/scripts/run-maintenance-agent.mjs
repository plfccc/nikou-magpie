import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from './lib/process.mjs';
const [root, logRoot, codex] = process.argv.slice(2);
if (!root || !logRoot || !codex) throw new Error('缺少维护执行路径');
const log = createWriteStream(path.join(logRoot, 'codex.log'), { encoding: 'utf8' });
// 使用网关中的完整模型 ID，避免裸 Codex 模型名走内置 OpenAI 登录路由。
const model = process.env.NIKOU_MAINTENANCE_MODEL || 'group/auto-gpt-6-1-sol';
const args = [codex, 'exec', '-C', root, '-m', model, '-c', 'model_provider="magpie"', '-s', 'danger-full-access', '-c', 'approval_policy="never"', '--color', 'never', '--output-schema', path.join(root, 'company/scripts/scheduled-update-result.schema.json'), '-o', path.join(logRoot, 'result.json'), '-'];
const progressFile = path.join(logRoot, 'progress.json');
const heartbeat = () => writeFileSync(path.join(logRoot, 'heartbeat.json'), JSON.stringify({ updatedAt: new Date().toISOString() }));
heartbeat();
const timer = setInterval(heartbeat, 15_000);
try {
  const result = await runProcess({ file: process.execPath, args, cwd: root, timeoutMs: 45 * 60_000,
    input: readFileSync(path.join(logRoot, 'instructions.md'), 'utf8'),
    env: { ...process.env, NIKOU_MAINTENANCE_PROGRESS_FILE: progressFile },
    onStdout: data => log.write(data), onStderr: data => log.write(data) });
  if (result.timedOut) log.write('\n维护超过45分钟，已结束本轮维护进程树，保留候选与旧安装。\n');
  process.exitCode = result.exitCode;
} finally { clearInterval(timer); await new Promise(resolve => log.end(resolve)); }
