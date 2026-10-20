import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runProcess } from './lib/process.mjs';

export function notificationText(result) {
  if (!['installed', 'failed', 'blocked', 'awaiting-maintenance-window'].includes(result.status)) return null;
  const title = result.status === 'installed' ? 'Nikou Magpie 自动更新完成' : 'Nikou Magpie 自动更新需要处理';
  return `${title}\n${result.summary || result.message || '请查看维护记录'}\n时间：${result.completedAt || '未知'}\n${result.status === 'installed' ? '变更说明已保存在本机维护记录。' : '当前版本保持不变。请回复此通知说明你的选择，再由维护会话核对后继续；不会把无关聊天当作批准。'}`;
}

export async function notifyMaintenance(stateRoot, { run = runProcess, config } = {}) {
  config ??= JSON.parse(await readFile(path.join(stateRoot, 'notification.json'), 'utf8'));
  if (config.enabled !== true) return { status: 'disabled' };
  if (!/^ou_[a-zA-Z0-9]+$/.test(config.userId) || !/^cli_[a-zA-Z0-9]+$/.test(config.profile)) throw Error('通知身份或收件人配置无效');
  const file = path.join(stateRoot, 'latest.json');
  const result = JSON.parse(await readFile(file, 'utf8'));
  const text = notificationText(result);
  if (!text) return { status: 'not-needed' };
  const key = createHash('sha256').update(JSON.stringify([result.status, result.completedAt, text])).digest('hex').slice(0, 40);
  const receiptFile = path.join(stateRoot, 'notifications', `${key}.json`);
  try { const previous = JSON.parse(await readFile(receiptFile, 'utf8')); if (previous.status === 'sent') return previous; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const args = [config.cliEntry, '--profile', config.profile, 'im', '+messages-send', '--as', 'bot', '--user-id', config.userId, '--text', text, '--idempotency-key', key];
  const response = await run({ file: process.execPath, args, timeoutMs: 60000 });
  let reply;
  try { reply = JSON.parse(response.stdout); } catch {}
  const receipt = response.exitCode === 0 && reply?.ok === true
    ? { status: 'sent', sentAt: new Date().toISOString(), messageId: reply.data?.message_id || reply.data?.messageId }
    : { status: 'failed', checkedAt: new Date().toISOString(), error: '飞书通知发送失败，请检查本机 lark-cli 认证和权限' };
  await mkdir(path.dirname(receiptFile), { recursive: true });
  await writeFile(receiptFile, JSON.stringify(receipt, null, 2));
  result.notification = receipt;
  await writeFile(file, JSON.stringify(result, null, 2));
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  notifyMaintenance(process.argv[2]).then(result => { console.log(JSON.stringify(result)); if (result.status === 'failed') process.exitCode = 1; }).catch(() => { console.error('维护通知未发送，请核对 notification.json 和飞书认证'); process.exitCode = 1; });
}
