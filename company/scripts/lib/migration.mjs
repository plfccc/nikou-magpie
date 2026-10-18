import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonical } from './report.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('迁移必须提供明确绝对路径');
  const result = path.resolve(value);
  // 不跟随链接或 Windows junction，避免受管目录逃逸。
  for (let p = result; ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('迁移路径不能包含符号链接');
    if (path.dirname(p) === p) break;
  }
  return result;
}
function bytes(file, optional = false) {
  try { return fs.readFileSync(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw new Error('配置文件不可读取'); }
}
function object(raw) {
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { fail('配置损坏或不是 JSON 对象，拒绝迁移'); }
}
function state(file, optional) {
  const raw = bytes(file, optional);
  if (raw !== null) object(raw);
  return { file, sha256: raw === null ? null : hash(raw), raw };
}
function inspect(options) {
  const paths = Object.fromEntries(['settingsPath', 'workerConfigPath', 'runtimeScopesPath', 'masterCredentialsPath', 'managedDir'].map(key => [key, absolute(options[key])]));
  if (new Set(Object.values(paths).map(p => process.platform === 'win32' ? p.toLowerCase() : p)).size !== 5) fail('配置与备份路径必须互不相同');
  for (const [key, file] of Object.entries(paths)) {
    if (key !== 'managedDir' && (file.startsWith(paths.managedDir + path.sep) || paths.managedDir.startsWith(file + path.sep))) fail('备份目录不能包含配置文件或位于配置文件下');
  }
  const files = {
    settings: state(paths.settingsPath), workerConfig: state(paths.workerConfigPath),
    runtimeScopes: state(paths.runtimeScopesPath, true), masterCredentials: state(paths.masterCredentialsPath, true),
  };
  const settings = object(files.settings.raw);
  const url = settings.nikouMasterBaseUrl;
  const key = settings.nikouMasterAdminKey;
  if (typeof url !== 'string' || typeof key !== 'string' || key.length < 24) fail('旧 Master 管理配置缺失或不满足控制台密钥要求');
  let parsed;
  try { parsed = new URL(url); } catch { fail('旧 Master 管理地址不合法'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) fail('旧 Master 管理地址不合法');
  const next = Buffer.from(JSON.stringify({ url: url.replace(/\/+$/, ''), key }, null, 2) + '\n');
  const existing = files.masterCredentials.raw;
  if (existing !== null) {
    const target = object(existing);
    if (target.url !== url.replace(/\/+$/, '') || target.key !== key) fail('控制台已有不同 Master 配置，必须人工处理，不能覆盖');
  }
  return { paths, files, settings, next: existing ?? next };
}
function publicPlan(data) {
  const files = Object.fromEntries(Object.entries(data.files).map(([name, value]) => [name, { path: value.file, sha256: value.sha256 }]));
  const body = { schemaVersion: 1, oldManager: 'cc-switch', newManager: 'nikou-console', files,
    managedDir: data.paths.managedDir,
    changes: [{ file: 'masterCredentials', fields: ['url', 'key'], beforeSha256: data.files.masterCredentials.sha256, afterSha256: hash(data.next) }],
    prerequisites: { oldAutostartDisabled: data.settings.nikouWorkerAutostart === false, manualOfflineHandoffRequired: true },
    limitations: ['不迁移账号和 profile，不承诺 Kiro 原生切换等价', '不启动、停止或监督 Worker；离线迁移完成后仍需人工验证运行态'] };
  return { ...body, migrationId: hash(canonical(body)).slice(0, 24) };
}
export function planMigration(options) { return publicPlan(inspect(options)); }
function privateWrite(file, value, flag = 'wx') {
  fs.writeFileSync(file, value, { flag, mode: 0o600 });
}
function atomicWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function receiptPath(options) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(options.requestId ?? '')) fail('requestId 格式不合法');
  return path.join(absolute(options.managedDir), options.requestId, 'receipt.json');
}
function assertOffline(data, options) {
  if (data.settings.nikouWorkerAutostart !== false) fail('必须先人工关闭 CC Switch Worker 自动启动');
  if (options.privateDirectoryConfirmed !== true) fail('必须确认受管备份目录仅当前用户和系统可访问（Windows ACL）');
  if (options.offlineConfirmed !== true || !Array.isArray(options.oldProcessIds) || options.oldProcessIds.length === 0) fail('必须明确确认旧监督器、Worker 和新控制台均已退出并提供已核验进程 ID');
  for (const pid of options.oldProcessIds) {
    if (!Number.isSafeInteger(pid) || pid <= 0) fail('进程 ID 不合法');
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; fail('无法核验旧进程退出'); }
    fail('旧进程仍在运行，拒绝交接');
  }
}
function unchanged(files) {
  for (const value of Object.values(files)) {
    const raw = bytes(value.file, true);
    if ((raw === null ? null : hash(raw)) !== value.sha256) fail('配置摘要变化，拒绝并发覆盖');
  }
}
export function applyMigration(options) {
  const receiptFile = receiptPath(options);
  if (fs.existsSync(receiptFile)) {
    const receipt = object(bytes(receiptFile));
    if (receipt.migrationId !== options.migrationId) fail('requestId 已绑定其他迁移');
    return receipt.result;
  }
  const data = inspect(options);
  const plan = publicPlan(data);
  if (options.migrationId !== plan.migrationId) fail('迁移计划已变化，请重新生成计划');
  assertOffline(data, options);
  fs.mkdirSync(data.paths.managedDir, { recursive: true, mode: 0o700 });
  const lock = path.join(data.paths.managedDir, '.migration.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    unchanged(data.files);
    fs.mkdirSync(path.dirname(receiptFile), { mode: 0o700 });
    for (const [name, value] of Object.entries(data.files)) if (value.raw !== null) privateWrite(path.join(path.dirname(receiptFile), `${name}.backup`), value.raw);
    const changed = data.files.masterCredentials.sha256 !== hash(data.next);
    const result = { migrationId: plan.migrationId, requestId: options.requestId, status: 'PREPARED', oldManager: 'cc-switch', newManager: 'nikou-console', runtimeStatus: 'MANUAL_VERIFICATION_REQUIRED', files: plan.files, changed };
    const receipt = { migrationId: plan.migrationId, result, target: data.paths.masterCredentialsPath, beforeSha256: data.files.masterCredentials.sha256, afterSha256: hash(data.next) };
    privateWrite(receiptFile, JSON.stringify(receipt));
    unchanged(data.files);
    if (changed) {
      fs.mkdirSync(path.dirname(receipt.target), { recursive: true, mode: 0o700 });
      // 仅允许创建新凭据文件，绝不覆盖已有用户配置。
      privateWrite(receipt.target, data.next);
    }
    const expected = { ...data.files, masterCredentials: { file: receipt.target, sha256: receipt.afterSha256 } };
    unchanged(expected);
    result.status = 'APPLIED_OFFLINE';
    atomicWrite(receiptFile, JSON.stringify(receipt));
    return result;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function restoreMigration(options) {
  const file = receiptPath(options);
  const receipt = object(bytes(file));
  if (receipt.migrationId !== options.migrationId) fail('迁移 ID 与回执不符');
  if (options.offlineConfirmed !== true) fail('恢复前必须确认 Worker 与控制台均已离线');
  const lock = path.join(absolute(options.managedDir), '.migration.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    if (receipt.result.status === 'RESTORED') return receipt.result;
    if (receipt.result.changed) {
      const target = absolute(receipt.target);
      const current = bytes(target, true);
      if (current !== null && hash(current) !== receipt.afterSha256) fail('恢复冲突：目标已被后续修改，保留当前文件和私有备份');
      if (receipt.beforeSha256 !== null) fail('恢复回执不符合仅新增凭据文件的约束');
      if (current !== null) fs.unlinkSync(target);
    }
    receipt.result.status = 'RESTORED';
    atomicWrite(file, JSON.stringify(receipt));
    return receipt.result;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
