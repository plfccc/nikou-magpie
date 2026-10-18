import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = raw => createHash('sha256').update(raw).digest('hex');
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('必须提供绝对路径');
  for (let p = path.resolve(value); ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('路径不能包含符号链接');
    if (p === path.dirname(p)) break;
  }
  return path.resolve(value);
}
function read(file) {
  const raw = fs.readFileSync(file);
  let config;
  try { config = JSON.parse(raw.toString('utf8')); } catch { fail('配置必须为严格 JSON'); }
  if (!object(config)) fail('配置必须为 JSON 对象');
  return { raw, config };
}
function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { fail('必须显式提供本机网关地址'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) fail('仅允许显式回环 HTTP 网关的 /v1 地址');
  return `${url.origin}/v1`;
}
function inspect(options) {
  const file = absolute(options.workerConfigPath);
  const { raw, config } = read(file);
  const hook = config.hook ?? config.ai_hook ?? config.aiHook;
  if (hook !== undefined && !object(hook)) fail('hook 必须为对象');
  const section = config.api ?? hook?.api ?? {};
  if (!object(section) || (section.profiles !== undefined && !object(section.profiles))) fail('API 配置格式不合法');
  if (Object.hasOwn(section.profiles ?? {}, 'magpie')) fail('magpie profile 已存在，拒绝覆盖');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.apiKeyEnv ?? '')) fail('必须提供 API key 环境变量名');
  return { file, raw, config, section, nested: config.api === undefined && hook?.api !== undefined };
}

export async function planProfile(options) {
  const data = inspect(options);
  const baseUrl = endpoint(options.gatewayUrl);
  const key = (options.env ?? process.env)[options.apiKeyEnv];
  if (typeof key !== 'string' || !key.trim()) fail('调用者环境变量缺少 API key');
  let payload;
  try {
    const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) fail('网关模型读取失败');
    const text = await response.text();
    if (text.length > 1024 * 1024) fail('网关模型响应过大');
    payload = JSON.parse(text);
  } catch { fail('本机网关模型读取失败'); }
  if (!Array.isArray(payload?.data) || payload.data.length === 0 || payload.data.some(item => !object(item) || typeof item.id !== 'string' || !item.id.trim() || item.id !== item.id.trim() || /(^|[/:_-])latest($|[/:_-])/i.test(item.id))) fail('网关模型列表不合法或含 latest 别名');
  const available = [...new Set(payload.data.map(item => item.id))].sort();
  const models = options.models ?? available;
  if (!Array.isArray(models) || !models.length || models.some(model => !available.includes(model)) || !models.includes(options.model ?? models[0])) fail('模型必须完整匹配网关白名单');
  const apiType = options.apiType ?? 'openai-chat';
  if (!['openai-chat', 'openai-responses', 'anthropic'].includes(apiType)) fail('不支持的 API 类型');
  const plan = { schemaVersion: 1, workerConfigPath: data.file, beforeSha256: hash(data.raw), profile: { name: 'magpie', base_url: baseUrl, api_key_env: options.apiKeyEnv, type: apiType, models: [...new Set(models)], model: options.model ?? models[0] }, activePreserved: true };
  return { ...plan, planId: hash(JSON.stringify(plan)) };
}

export function applyProfile(options) {
  const plan = options.plan;
  if (options.confirmed !== true || options.offlineConfirmed !== true || options.privateDirectoryConfirmed !== true) fail('必须显式确认计划、离线状态与私有备份目录权限');
  if (!object(plan)) fail('缺少计划');
  const { planId, ...body } = plan;
  if (hash(JSON.stringify(body)) !== planId) fail('计划摘要不匹配');
  const data = inspect({ ...options, workerConfigPath: plan.workerConfigPath, apiKeyEnv: plan.profile.api_key_env });
  if (hash(data.raw) !== plan.beforeSha256) fail('配置已并发修改，请重新生成计划');
  const managed = absolute(options.managedDir);
  if (managed === data.file || managed.startsWith(data.file + path.sep) || data.file.startsWith(managed + path.sep)) fail('备份目录必须与配置隔离');
  fs.mkdirSync(managed, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (fs.statSync(managed).mode & 0o077)) fail('备份目录不是私有目录');
  const lock = `${data.file}.magpie.lock`;
  const fd = fs.openSync(lock, 'wx', 0o600);
  const temporary = `${data.file}.${randomUUID()}.tmp`;
  try {
    if (hash(fs.readFileSync(data.file)) !== plan.beforeSha256) fail('配置已并发修改');
    fs.writeFileSync(path.join(managed, `${randomUUID()}.backup`), data.raw, { flag: 'wx', mode: 0o600 });
    const { name, ...profile } = plan.profile;
    const section = { ...data.section, profiles: { ...data.section.profiles, magpie: profile } };
    if (data.nested) (data.config.hook ?? data.config.ai_hook ?? data.config.aiHook).api = section;
    else data.config.api = section;
    fs.writeFileSync(temporary, JSON.stringify(data.config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (hash(fs.readFileSync(data.file)) !== plan.beforeSha256) fail('配置已并发修改');
    fs.renameSync(temporary, data.file);
    return { status: 'APPLIED_OFFLINE', planId, profile: 'magpie', activePreserved: true };
  } finally {
    fs.closeSync(fd); fs.unlinkSync(lock);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
