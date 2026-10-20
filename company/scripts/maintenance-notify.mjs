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

export function notificationCard(result) {
  const text = notificationText(result);
  if (!text) return null;
  if (/\uFFFD|\?{3,}/u.test(text)) throw Error('通知正文编码异常，拒绝发送乱码；请从 UTF-8 源文件重建摘要');
  const installed = result.status === 'installed';
  const title = installed ? 'Nikou Magpie · 更新完成' : result.status === 'blocked' ? 'Nikou Magpie · 需要你确认' : 'Nikou Magpie · 更新未完成';
  const md = content => ({ tag: 'markdown', content });
  const details = result.notificationDetails;
  const versions = details?.versions;
  const elements = [];
  if (versions?.length) elements.push({ tag: 'column_set', flex_mode: 'none', background_style: installed ? 'green-50' : 'grey-50', columns: versions.map(item => ({
    tag: 'column', width: 'weighted', weight: 1, elements: [md(`**${item.name}**\n${item.from} → **${item.to}**`)],
  })) });
  if (details?.changes?.length) elements.push(md(`**本次更新**\n${details.changes.map(item => `• ${item}`).join('\n')}`));
  else elements.push(md(`**${installed ? '更新摘要' : '处理说明'}**\n${result.summary || result.message || '请查看维护记录'}`));
  if (details?.validation) elements.push(md(`**验证结果**\n${details.validation}`));
  elements.push(md(details?.runtime || (installed ? '已完成本机安装。' : '当前安装保持不变。请回复本通知说明你的选择，由维护会话核对后继续。')));
  const date = new Date(result.completedAt);
  return { schema: '2.0', config: { update_multi: true, width_mode: 'default', summary: { content: title } },
    header: { template: installed ? 'green' : result.status === 'blocked' ? 'orange' : 'red', title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: Number.isNaN(date.getTime()) ? '本机自动维护' : `${date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · 北京时间` } },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements } };
}

export async function notifyMaintenance(stateRoot, { run = runProcess, config } = {}) {
  config ??= JSON.parse(await readFile(path.join(stateRoot, 'notification.json'), 'utf8'));
  if (config.enabled !== true) return { status: 'disabled' };
  if (!/^ou_[a-zA-Z0-9]+$/.test(config.userId) || !/^cli_[a-zA-Z0-9]+$/.test(config.profile)) throw Error('通知身份或收件人配置无效');
  const file = path.join(stateRoot, 'latest.json');
  const result = JSON.parse(await readFile(file, 'utf8'));
  const card = notificationCard(result);
  if (!card) return { status: 'not-needed' };
  const content = JSON.stringify(card);
  if (/\uFFFD|\?{3,}/u.test(content)) throw Error('通知卡片编码异常，拒绝发送');
  const key = createHash('sha256').update(JSON.stringify([result.status, result.completedAt, card])).digest('hex').slice(0, 40);
  const receiptFile = path.join(stateRoot, 'notifications', `${key}.json`);
  try { const previous = JSON.parse(await readFile(receiptFile, 'utf8')); if (previous.status === 'sent') return previous; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const args = [config.cliEntry, '--profile', config.profile, 'im', '+messages-send', '--as', 'bot', '--user-id', config.userId, '--msg-type', 'interactive', '--content', content, '--idempotency-key', key];
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
