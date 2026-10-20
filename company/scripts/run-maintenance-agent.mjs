import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import path from 'node:path';
const [root, logRoot, codex] = process.argv.slice(2);
if (!root || !logRoot || !codex) throw new Error('缺少维护执行路径');
const log = createWriteStream(path.join(logRoot, 'codex.log'), { encoding: 'utf8' });
// 使用网关中的完整模型 ID，避免裸 Codex 模型名走内置 OpenAI 登录路由。
const model = process.env.NIKOU_MAINTENANCE_MODEL || 'group/auto-gpt-6-1-sol';
const args = [codex, 'exec', '-C', root, '-m', model, '-c', 'model_provider="magpie"', '-s', 'danger-full-access', '-c', 'approval_policy="never"', '--color', 'never', '--output-schema', path.join(root, 'company/scripts/scheduled-update-result.schema.json'), '-o', path.join(logRoot, 'result.json'), '-'];
const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
child.stdin.on('error', () => {});
child.stdin.end(readFileSync(path.join(logRoot, 'instructions.md')));
child.once('error', error => { log.end(error.message); process.exitCode = 1; });
child.once('close', code => { log.end(); process.exitCode = code ?? 1; });
