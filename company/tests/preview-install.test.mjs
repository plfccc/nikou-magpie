import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validatePreview, installPreview, launcher, protectPreviewDirectory } from '../scripts/install-preview.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preview-install-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = [];
  for (const name of ['test.exe', 'test.tgz']) {
    const bytes = Buffer.from(name); await writeFile(path.join(root, name), bytes);
    assets.push({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const infoFile = path.join(root, 'preview-info.json');
  const info = { developmentOnly: true, releaseEligible: false, protocol: 1, assets };
  await writeFile(infoFile, JSON.stringify(info));
  return { root, infoFile, info };
}
test('已保护目录只读复核 ACL，避免升级时遍历旧依赖树', async () => {
  const calls = [];
  await protectPreviewDirectory('C:\\fixture', async spec => { calls.push(spec.file); return { exitCode: 0, stdout: 'True\n' }; });
  assert.deepEqual(calls, ['powershell.exe']);
});
test('权限未达标必须加固且复核，不能因 icacls 返回成功就放行', async () => {
  let checks = 0; const calls = [];
  await assert.rejects(protectPreviewDirectory('C:\\fixture', async spec => {
    calls.push(spec);
    if (spec.file === 'powershell.exe') { checks++; return { exitCode: 0, stdout: 'False\n' }; }
    if (spec.file === 'whoami.exe') return { exitCode: 0, stdout: 'S-1-5-21-123' };
    return { exitCode: 0, stdout: '' };
  }), /无法保护/);
  assert.equal(checks, 2);
  assert.equal(calls.find(c => c.file === 'icacls.exe').timeoutMs, 120_000);
});
test('预览产物被改动时在安装前拒绝', async t => {
  const f = await fixture(t); await validatePreview(f.infoFile);
  await writeFile(path.join(f.root, 'test.exe'), 'changed');
  await assert.rejects(validatePreview(f.infoFile), /校验失败/);
});
test('预览不能冒充正式版本，也不能读取越界资产', async t => {
  const f = await fixture(t);
  await writeFile(f.infoFile, JSON.stringify({ ...f.info, releaseEligible: true }));
  await assert.rejects(validatePreview(f.infoFile), /开发预览/);
  f.info.assets[0].name = '../test.exe'; await writeFile(f.infoFile, JSON.stringify(f.info));
  await assert.rejects(validatePreview(f.infoFile), /路径或摘要/);
});
test('非空陌生目录和现有排他锁拒绝安装', async t => {
  const f = await fixture(t); const root = path.join(f.root, 'install'); await mkdir(root);
  await writeFile(path.join(root, 'precious.txt'), '保留');
  await assert.rejects(installPreview({ infoFile: f.infoFile, installRoot: root }), /非空/);
  assert.equal(await readFile(path.join(root, 'precious.txt'), 'utf8'), '保留');
  await rm(path.join(root, 'precious.txt'));
  await writeFile(path.join(root, '.nikou-magpie-preview.json'), JSON.stringify({ product: 'nikou-magpie-preview', developmentOnly: true, releaseEligible: false }));
  await writeFile(path.join(root, '.install.lock'), 'busy');
  await assert.rejects(installPreview({ infoFile: f.infoFile, installRoot: root }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(root, '.install.lock'), 'utf8'), 'busy');
});
test('暂存失败保留现有安装指针并移除本次锁', async t => {
  const f = await fixture(t); const root = path.join(f.root, 'install'); await mkdir(root);
  await writeFile(path.join(root, '.nikou-magpie-preview.json'), JSON.stringify({ product: 'nikou-magpie-preview', developmentOnly: true, releaseEligible: false }));
  const pointer = JSON.stringify({ directory: 'releases/old', transactionId: 'old' }); await writeFile(path.join(root, 'current.json'), pointer);
  await assert.rejects(installPreview({ infoFile: f.infoFile, installRoot: root, skipAcl: true }), /Node 版本或 ABI/);
  assert.equal(await readFile(path.join(root, 'current.json'), 'utf8'), pointer);
  await assert.rejects(readFile(path.join(root, '.install.lock')), { code: 'ENOENT' });
});
test('控制台入口拒绝端口冲突和运行中的 Worker，不执行 Worker 启动命令', () => {
  const script = launcher('console');
  assert.match(script, /Get-NetTCPConnection/); assert.match(script, /nikou-worker-control/);
  assert.match(script, /NIKOU_CONSOLE_AUTO_START = '0'/); assert.match(script, /hook console --port/);
  assert.match(script, /NIKOU_PREVIEW_NO_LIBRARY_SYNC = '1'/);
  assert.match(launcher('magpie'), /NIKOU_PREVIEW_NO_LIBRARY_SYNC = '1'/);
  assert.doesNotMatch(script, /hook worker|worker start|Start-Service/);
});
test('完整暂存和隔离检查后才激活；后续依赖安装失败保留原版本', async t => {
  const f = await fixture(t);
  const nikouDir = process.env.NIKOU_TEST_SOURCE_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../nikou-cli-integration');
  const tar = createRequire(path.join(nikouDir, 'package.json'))('tar');
  const packageDir = path.join(f.root, 'package'); await mkdir(path.join(packageDir, 'dist'), { recursive: true });
  const pkgBytes = await readFile(path.join(nikouDir, 'package.json'));
  const pkg = JSON.parse(pkgBytes);
  await writeFile(path.join(packageDir, 'package.json'), pkgBytes);
  await writeFile(path.join(packageDir, 'dist/index.js'), '// 隔离安装测试');
  await tar.c({ cwd: f.root, file: path.join(f.root, 'test.tgz'), gzip: true }, ['package']);
  const tgzBytes = await readFile(path.join(f.root, 'test.tgz'));
  f.info.assets[1] = { name: 'test.tgz', size: tgzBytes.length, sha256: createHash('sha256').update(tgzBytes).digest('hex') };
  const upstream = JSON.parse(await readFile(new URL('../upstreams.lock.json', import.meta.url)));
  Object.assign(f.info, { nodeVersion: process.versions.node, nodeAbi: process.versions.modules, companyVersion: '1.0.0-dev.1', nikouEffectiveCommit: upstream.nikou.effectiveCommit, developmentSourceDirty: true, localSourceChanges: ['开发预览启动同步保护'] });
  await writeFile(f.infoFile, JSON.stringify(f.info));
  const root = path.join(f.root, 'install');
  const run = async spec => {
    if (spec.args[0].endsWith('npm-cli.js')) return { exitCode: 0, stdout: '', stderr: '' };
    assert.notEqual(spec.env.USERPROFILE, process.env.USERPROFILE);
    const component = spec.args[0] === 'nikou-self-check' ? 'magpie' : 'nikou';
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, protocol: 1, component, version: component === 'magpie' ? f.info.companyVersion : pkg.version, nodeAbi: process.versions.modules }), stderr: '' };
  };
  const installed = await installPreview({ infoFile: f.infoFile, installRoot: root, nikouDir, skipAcl: true, run });
  assert.equal(installed.receipt.distFileCount, 1);
  assert.equal(installed.receipt.developmentSourceDirty, true);
  assert.deepEqual(installed.receipt.localSourceChanges, f.info.localSourceChanges);
  assert.equal(installed.receipt.startupLibrarySyncSuppressed, true);
  const pointer = await readFile(path.join(root, 'current.json'), 'utf8');
  assert.equal(JSON.parse(pointer).transactionId, installed.receipt.transactionId);
  await assert.rejects(installPreview({ infoFile: f.infoFile, installRoot: root, nikouDir, skipAcl: true, run: async () => ({ exitCode: 1, stderr: '模拟依赖安装失败' }) }), /依赖安装失败/);
  assert.equal(await readFile(path.join(root, 'current.json'), 'utf8'), pointer);
});
