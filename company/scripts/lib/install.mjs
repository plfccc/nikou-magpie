import { mkdir, lstat, readFile, writeFile, rename, rm, cp, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { digest, failure, IntegrationError } from './lock.mjs';
import { fingerprint, json, safeDirectory, validateAssets, sandbox } from './evidence.mjs';
import { runProcess } from './process.mjs';

const terminal = new Set(['COMMITTED', 'ROLLED_BACK']);
const markerName = '.nikou-magpie-managed.json';
const noFile = async file => { try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
}
async function managedRoot(value) {
  if (!value || !path.isAbsolute(value)) throw new IntegrationError(2, '必须指定绝对安装目录');
  const root = path.resolve(value);
  if ([path.parse(root).root, os.homedir(), process.env.USERPROFILE].filter(Boolean).some(p => path.resolve(p).toLowerCase() === root.toLowerCase())) throw new IntegrationError(2, '不能以磁盘根目录或用户主目录作为安装目录');
  // 从盘符开始逐级检查，防止父目录的 junction 绕过边界。
  await safeDirectory(path.parse(root).root, root);
  await mkdir(root, { recursive: true });
  const marker = path.join(root, markerName);
  const existing = await noFile(marker);
  if (existing === null) {
    if ((await readdir(root)).length) throw new IntegrationError(2, '安装目录非空且不受公司安装器管理');
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, product: 'nikou-magpie' }), { flag: 'wx', mode: 0o600 });
  } else {
    const metadata = JSON.parse(existing);
    if (metadata.product !== 'nikou-magpie' || metadata.schemaVersion !== 1) throw new IntegrationError(2, '安装目录标记无效');
  }
  for (const name of ['transactions', 'releases']) {
    const target = path.join(root, name); await safeDirectory(root, target); await mkdir(target, { recursive: true });
  }
  return root;
}
async function lock(root, action) {
  const file = path.join(root, '.install.lock');
  await safeDirectory(root, file);
  let handle;
  try { handle = await open(file, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new IntegrationError(12, '存在安装锁；请核实进程和事务后再恢复，禁止自动抢锁'); throw e; }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return await action(); }
  finally { await handle.close(); await rm(file); }
}
function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.bridgeProtocol !== 1 || manifest.platform !== 'windows' || manifest.arch !== 'amd64' || !/^\d+\.\d+\.\d+$/.test(manifest.companyVersion ?? '')) throw new IntegrationError(15, '安装清单版本或平台无效');
  for (const key of ['magpieUpstreamCommit', 'magpieCompanyCommit', 'nikouUpstreamCommit', 'nikouEffectiveCommit']) if (!/^[0-9a-f]{40}$/.test(manifest[key] ?? '')) throw new IntegrationError(15, '清单缺少完整源码身份');
  if (!Array.isArray(manifest.assets) || manifest.packageSha256 !== fingerprint(manifest.assets)) throw new IntegrationError(15, '组合包摘要无效');
  const entries = [manifest.components?.magpie?.entry, manifest.components?.nikou?.entry, manifest.components?.nikou?.node];
  const seen = new Set();
  for (const asset of manifest.assets) {
    if (typeof asset.path !== 'string' || !asset.path.startsWith('assets/') || asset.path.includes('\\') || asset.path.split('/').some(v => !v || v === '.' || v === '..') || seen.has(asset.path.toLowerCase()) || !/^[0-9a-f]{64}$/.test(asset.sha256 ?? '') || !Number.isSafeInteger(asset.size) || asset.size < 0) throw new IntegrationError(15, '资产路径、大小或摘要无效');
    seen.add(asset.path.toLowerCase());
  }
  for (const entry of entries) if (!entry || !manifest.assets.some(a => a.path === entry)) throw new IntegrationError(15, '清单入口不在已校验资产中');
}
async function readPointer(root) {
  const file = path.join(root, 'current.json'); await safeDirectory(root, file);
  const bytes = await noFile(file);
  if (bytes === null) return null;
  const value = JSON.parse(bytes);
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(value.transactionId ?? '') || value.directory !== `releases/${value.transactionId}` || !/^[0-9a-f]{64}$/.test(value.manifestSha256 ?? '')) throw new IntegrationError(15, '当前版本指针损坏，停止安装');
  await safeDirectory(root, path.join(root, value.directory)); return value;
}
async function health(directory, manifest, options) {
  if (options.healthCheck) {
    if (await options.healthCheck({ directory, manifest }) !== true) throw new IntegrationError(14, '组合健康检查失败');
    return;
  }
  const isolated = await sandbox(path.join(options.installRoot, 'transactions'));
  try {
    for (const [component, file, args] of [
      ['magpie', manifest.components.magpie.entry, ['nikou-self-check', '--json']],
      ['nikou', manifest.components.nikou.node, [path.join(directory, manifest.components.nikou.entry), 'integration-check', '--json']]
    ]) {
      const result = await runProcess({ file: path.join(directory, file), args, cwd: directory, env: isolated.env, timeoutMs: 30_000 });
      let reply; try { reply = JSON.parse(result.stdout.trim()); } catch { throw new IntegrationError(14, '组件自检未返回有效JSON'); }
      if (result.exitCode !== 0 || reply.ok !== true || reply.protocol !== 1 || reply.component !== component || reply.version !== (component === 'magpie' ? manifest.companyVersion : manifest.components.nikou.version) || (component === 'nikou' && String(reply.nodeAbi) !== String(manifest.requirements.nodeAbi))) throw new IntegrationError(14, '组件版本、ABI或自检失败');
    }
  } finally { await rm(isolated.dir, { recursive: true, force: true }); }
}
async function state(root, tx, value) {
  tx.state = value; tx.updatedAt = new Date().toISOString(); tx.steps.push(value);
  await atomic(path.join(root, 'transactions', `${tx.transactionId}.json`), tx);
}
async function restore(root, tx, options) {
  await state(root, tx, 'ROLLING_BACK');
  try {
    const current = await readPointer(root);
    // 不覆盖另一次安装或人工调整过的指针。
    if (fingerprint(current) !== fingerprint(tx.previous) && (!tx.expected || fingerprint(current) !== fingerprint(tx.expected))) throw new IntegrationError(16, '当前指针已发生其他变更，需人工恢复');
    if (tx.previous) {
      const directory = path.join(root, tx.previous.directory);
      const bytes = await readFile(path.join(directory, 'release-manifest.json'));
      if (digest(bytes) !== tx.previous.manifestSha256) throw new IntegrationError(15, '旧版本清单摘要不符');
      const manifest = JSON.parse(bytes); validateManifest(manifest);
      await validateAssets({ exitCode: 0, buildDir: directory, assets: manifest.assets });
      await health(directory, manifest, { ...options, installRoot: root });
      if (fingerprint(await readPointer(root)) !== fingerprint(current)) throw new IntegrationError(16, '健康检查期间当前指针已变更，需人工恢复');
      await atomic(path.join(root, 'current.json'), tx.previous);
    } else {
      if (fingerprint(await readPointer(root)) !== fingerprint(current)) throw new IntegrationError(16, '删除前当前指针已变更，需人工恢复');
      await rm(path.join(root, 'current.json'), { force: true });
    }
    await state(root, tx, 'ROLLED_BACK');
  } catch (e) { await state(root, tx, 'RECOVERY_REQUIRED'); throw e; }
}
export async function installRelease(options = {}) {
  let tx, root;
  try {
    if (options.offline !== true) throw new IntegrationError(2, '首版仅支持离线安装：先关闭旧自动拉起、Worker、控制台及magpie，再明确传入--offline');
    if (!options.manifestPath || !path.isAbsolute(options.manifestPath)) throw new IntegrationError(2, '必须指定绝对manifest路径');
    const bytes = await readFile(options.manifestPath); const manifest = JSON.parse(bytes); validateManifest(manifest);
    const source = path.dirname(options.manifestPath); await safeDirectory(path.parse(source).root, source);
    await validateAssets({ exitCode: 0, buildDir: source, assets: manifest.assets });
    root = await managedRoot(options.installRoot);
    return await lock(root, async () => {
      for (const file of (await readdir(path.join(root, 'transactions'))).filter(v => v.endsWith('.json'))) {
        const old = await json(path.join(root, 'transactions', file));
        if (!terminal.has(old.state)) throw new IntegrationError(16, '有未完成事务，必须先按事务ID恢复');
      }
      tx = { schemaVersion: 1, transactionId: randomUUID(), manifestSha256: digest(bytes), packageSha256: manifest.packageSha256, previous: await readPointer(root), steps: [], createdAt: new Date().toISOString() };
      tx.expected = { schemaVersion: 1, transactionId: tx.transactionId, directory: `releases/${tx.transactionId}`, manifestSha256: tx.manifestSha256 };
      const directory = path.join(root, 'releases', tx.transactionId); await mkdir(directory);
      await state(root, tx, 'STAGED');
      try {
        for (const item of manifest.assets) {
          const target = path.join(directory, item.path); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(source, item.path), target, { force: false, errorOnExist: true });
        }
        await writeFile(path.join(directory, 'release-manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
        await validateAssets({ exitCode: 0, buildDir: directory, assets: manifest.assets });
        await state(root, tx, 'VERIFIED'); await state(root, tx, 'BACKED_UP');
        // 离线模式不管理真实进程；由调用者确认旧管理方已停止。
        await state(root, tx, 'OLD_STOPPED'); await state(root, tx, 'ACTIVATING');
        await health(directory, manifest, { ...options, installRoot: root });
        await state(root, tx, 'HEALTHY');
        if (fingerprint(await readPointer(root)) !== fingerprint(tx.previous)) throw new IntegrationError(16, '激活前指针被并发修改');
        await atomic(path.join(root, 'current.json'), tx.expected);
        await state(root, tx, 'COMMITTED');
        return { exitCode: 0, ok: true, installRoot: root, ...tx };
      } catch (e) { await restore(root, tx, options); throw e; }
    });
  } catch (e) { return { ...failure(e), transactionId: tx?.transactionId, state: tx?.state, installRoot: root }; }
}
export async function rollbackRelease(options = {}) {
  let tx;
  try {
    if (options.offline !== true || !/^[a-zA-Z0-9-]{1,100}$/.test(options.transactionId ?? '')) throw new IntegrationError(2, '回滚必须明确离线模式和事务ID');
    const root = await managedRoot(options.installRoot);
    return await lock(root, async () => {
      const file = path.join(root, 'transactions', `${options.transactionId}.json`); await safeDirectory(root, file); tx = await json(file);
      if (tx.transactionId !== options.transactionId) throw new IntegrationError(15, '事务身份不一致');
      if (tx.state !== 'ROLLED_BACK') await restore(root, tx, options);
      return { exitCode: 0, ok: true, installRoot: root, ...tx };
    });
  } catch (e) { return { ...failure(e), transactionId: options.transactionId, state: tx?.state }; }
}
export async function resolveInstalled(installRoot) {
  const root = await managedRoot(installRoot); const pointer = await readPointer(root);
  if (!pointer) throw new IntegrationError(16, '尚未安装可运行组合');
  const directory = path.join(root, pointer.directory); const bytes = await readFile(path.join(directory, 'release-manifest.json'));
  if (digest(bytes) !== pointer.manifestSha256) throw new IntegrationError(15, '安装清单已被修改');
  const manifest = JSON.parse(bytes); validateManifest(manifest); await validateAssets({ exitCode: 0, buildDir: directory, assets: manifest.assets });
  return { root, directory, manifest, pointer };
}
