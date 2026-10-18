import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installRelease, rollbackRelease, resolveInstalled } from '../scripts/lib/install.mjs';
import { digest } from '../scripts/lib/lock.mjs';
import { fingerprint } from '../scripts/lib/evidence.mjs';

for (const duringHealth of [false, true]) {
  test(`回滚保留${duringHealth ? '健康检查期间' : '同一事务'}的人工指针修改`, async t => {
    const w = await fixture(t);
    await installRelease(w);
    const second = await installRelease(w);
    const file = path.join(w.installRoot, 'current.json');
    const edited = { ...JSON.parse(await readFile(file)), manifestSha256: 'f'.repeat(64) };
    if (!duringHealth) await writeFile(file, JSON.stringify(edited));
    const rolled = await rollbackRelease({ ...w, transactionId: second.transactionId,
      healthCheck: async () => { if (duringHealth) await writeFile(file, JSON.stringify(edited)); return true; } });
    assert.equal(rolled.state, 'RECOVERY_REQUIRED');
    assert.equal(rolled.exitCode, 16);
    assert.deepEqual(JSON.parse(await readFile(file)), edited);
  });
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), '公司 安装测试-'));
  t.after(() => rm(base, { force: true, recursive: true }));
  const source = path.join(base, '包'); await mkdir(path.join(source, 'assets'), { recursive: true });
  const assets = [];
  for (const [name, role] of [['magpie.exe', 'magpie'], ['node.exe', 'node-runtime'], ['index.js', 'nikou-runtime']]) {
    const content = Buffer.from(name); await writeFile(path.join(source, 'assets', name), content);
    assets.push({ path: `assets/${name}`, role, size: content.length, sha256: digest(content) });
  }
  const manifest = { schemaVersion: 1, bridgeProtocol: 1, platform: 'windows', arch: 'amd64', companyVersion: '1.0.0',
    ...Object.fromEntries(['magpieUpstreamCommit', 'magpieCompanyCommit', 'nikouUpstreamCommit', 'nikouEffectiveCommit'].map(k => [k, 'a'.repeat(40)])),
    components: { magpie: { entry: 'assets/magpie.exe' }, nikou: { entry: 'assets/index.js', node: 'assets/node.exe', version: '0.1.89' } },
    requirements: { nodeAbi: '137' }, assets, packageSha256: fingerprint(assets) };
  const manifestPath = path.join(source, 'release-manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  const installRoot = path.join(base, '受管 安装');
  return { base, source, manifest, manifestPath, installRoot, offline: true, healthCheck: async () => true };
}

test('真实复制组合资产，健康后提交单一指针；再次安装与回滚保持整组身份', async t => {
  const w = await fixture(t); const first = await installRelease(w); assert.equal(first.exitCode, 0, JSON.stringify(first));
  const original = await resolveInstalled(w.installRoot);
  assert.equal(original.pointer.transactionId, first.transactionId);
  assert.deepEqual(first.steps, ['STAGED', 'VERIFIED', 'BACKED_UP', 'OLD_STOPPED', 'ACTIVATING', 'HEALTHY', 'COMMITTED']);
  assert.equal(await readFile(path.join(original.directory, 'assets/index.js'), 'utf8'), 'index.js');
  const second = await installRelease(w); assert.equal(second.exitCode, 0);
  assert.equal((await resolveInstalled(w.installRoot)).pointer.transactionId, second.transactionId);
  const rolled = await rollbackRelease({ ...w, transactionId: second.transactionId }); assert.equal(rolled.state, 'ROLLED_BACK');
  assert.equal((await resolveInstalled(w.installRoot)).pointer.transactionId, first.transactionId);
  assert.equal((await rollbackRelease({ ...w, transactionId: second.transactionId })).exitCode, 0);
});

test('新组合自检失败恢复旧组合，恢复也失败时保留RECOVERY_REQUIRED现场', async t => {
  const w = await fixture(t); const first = await installRelease(w); assert.equal(first.exitCode, 0);
  const failed = await installRelease({ ...w, healthCheck: async ({ directory }) => directory.endsWith(first.transactionId) });
  assert.equal(failed.exitCode, 14); assert.equal(failed.state, 'ROLLED_BACK');
  assert.equal((await resolveInstalled(w.installRoot)).pointer.transactionId, first.transactionId);
  const recovery = await installRelease({ ...w, healthCheck: async () => false });
  assert.equal(recovery.state, 'RECOVERY_REQUIRED');
  assert.equal((await installRelease(w)).exitCode, 16);
  assert.equal((await rollbackRelease({ ...w, transactionId: recovery.transactionId })).state, 'ROLLED_BACK');
});

test('安装前拒绝错误摘要、非受管目录、非离线模式与越界入口', async t => {
  const w = await fixture(t);
  assert.equal((await installRelease({ ...w, offline: false })).exitCode, 2);
  const occupied = path.join(w.base, '用户文件'); await mkdir(occupied); await writeFile(path.join(occupied, 'keep.txt'), '保留');
  assert.equal((await installRelease({ ...w, installRoot: occupied })).exitCode, 2);
  await writeFile(path.join(w.source, 'assets/index.js'), '被修改');
  assert.equal((await installRelease(w)).exitCode, 15);
  w.manifest.components.nikou.entry = '../index.js'; await writeFile(w.manifestPath, JSON.stringify(w.manifest));
  assert.equal((await installRelease(w)).exitCode, 15);
  assert.equal(await readFile(path.join(occupied, 'keep.txt'), 'utf8'), '保留');
});

test('文件锁、损坏指针、后续安装和junction阻止不安全回滚', async t => {
  const w = await fixture(t); const first = await installRelease(w);
  const lockFile = path.join(w.installRoot, '.install.lock'); await writeFile(lockFile, '正在运行');
  assert.equal((await installRelease(w)).exitCode, 12); await rm(lockFile);
  const second = await installRelease(w); const third = await installRelease(w);
  assert.equal((await rollbackRelease({ ...w, transactionId: second.transactionId })).state, 'RECOVERY_REQUIRED');
  assert.equal((await resolveInstalled(w.installRoot)).pointer.transactionId, third.transactionId);
  await writeFile(path.join(w.installRoot, 'current.json'), '{}');
  assert.equal((await rollbackRelease({ ...w, transactionId: first.transactionId })).exitCode, 15);
  const link = path.join(w.base, '链接'); await symlink(w.installRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await installRelease({ ...w, installRoot: path.join(link, '子目录') })).exitCode, 2);
});

test('进程中断事务必须先恢复，不能跳过或自动抢锁', async t => {
  const w = await fixture(t); const first = await installRelease(w);
  const txFile = path.join(w.installRoot, 'transactions', `${first.transactionId}.json`);
  const tx = JSON.parse(await readFile(txFile)); tx.state = 'ACTIVATING'; await writeFile(txFile, JSON.stringify(tx));
  assert.equal((await installRelease(w)).exitCode, 16);
  assert.equal((await rollbackRelease({ ...w, transactionId: first.transactionId })).state, 'ROLLED_BACK');
  await assert.rejects(resolveInstalled(w.installRoot), /尚未安装/);
});
