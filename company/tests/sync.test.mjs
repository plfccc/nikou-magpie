import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { workspace } from './fixtures/git/workspace.mjs';
import { mkdir, access } from 'node:fs/promises';

test('同步规划区分公司HEAD与锁定上游且脏目录无执行动作', async () => {
  const module = await import('../scripts/lib/sync.mjs').catch(() => ({}));
  assert.equal(typeof module.planSync, 'function', '必须实现隔离同步规划');
  const base = 'a'.repeat(40), locked = { magpie: 'b'.repeat(40), nikou: 'c'.repeat(40) };
  const result = module.planSync({ component: 'both', baseCommit: base, currentCommit: base, dirty: false, lockedUpstreams: locked, candidateUpstreams: locked });
  assert.equal(result.ok, true); assert.deepEqual(result.actions, []);
  assert.deepEqual(module.planSync({ component: 'both', dirty: true }), { ok: false, exitCode: 10, changedComponents: [], actions: [] });
});

test('真实Git隔离合并保留公司文件，dry-run无写入且重复运行幂等', async t => {
  const { sync } = await import('../scripts/lib/sync.mjs');
  const { checkUpstreams } = await import('../scripts/lib/report.mjs');
  const w = await workspace(t);
  await w.writeFile(`${w.upstream}/new.txt`, '上游新增'); w.git(w.upstream, 'add', '.'); w.git(w.upstream, 'commit', '-m', '新增');
  const report = await checkUpstreams(w);
  const original = w.git(w.root, 'rev-parse', 'HEAD');
  const preview = await sync({ ...w, report, component: 'magpie', dryRun: true });
  assert.equal(preview.exitCode, 0); assert.equal(w.git(w.root, 'worktree', 'list', '--porcelain').match(/worktree /g).length, 1);
  const result = await sync({ ...w, report, component: 'magpie' });
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.status, 'complete');
  assert.equal(w.git(w.root, 'rev-parse', 'HEAD'), original);
  assert.equal(await w.readFile(`${result.worktrees.magpie}/new.txt`, 'utf8'), '上游新增');
  assert.ok(await w.readFile(`${result.worktrees.magpie}/company/upstreams.policy.json`));
  const mergedHead = w.git(result.worktrees.magpie, 'rev-parse', 'HEAD');
  const repeated = await sync({ ...w, report, component: 'magpie' });
  assert.equal(repeated.exitCode, 0, JSON.stringify(repeated)); assert.equal(repeated.integrationId, result.integrationId);
  assert.equal(w.git(result.worktrees.magpie, 'rev-parse', 'HEAD'), mergedHead);
  await w.writeFile(`${result.worktrees.magpie}/company/upstreams.lock.json`, '用户修改');
  assert.equal((await sync({ ...w, report, component: 'magpie' })).exitCode, 15);
  assert.equal(await w.readFile(`${result.worktrees.magpie}/company/upstreams.lock.json`, 'utf8'), '用户修改');
});

test('报告过期、摘要篡改、移动ref和脏公司目录拒绝执行', async t => {
  const { sync } = await import('../scripts/lib/sync.mjs');
  const { checkUpstreams, sealReport } = await import('../scripts/lib/report.mjs');
  const w = await workspace(t); const report = await checkUpstreams(w);
  assert.equal((await sync({ ...w, report: { ...report, changed: true }, component: 'both' })).exitCode, 2);
  assert.equal((await sync({ ...w, report: sealReport({ ...report, createdAt: '2000-01-01T00:00:00Z' }), component: 'both' })).exitCode, 2);
  await w.writeFile(`${w.upstream}/new.txt`, '移动'); w.git(w.upstream, 'add', '.'); w.git(w.upstream, 'commit', '-m', '移动');
  assert.equal((await sync({ ...w, report, component: 'both' })).exitCode, 2);
  await w.writeFile(`${w.root}/dirty.txt`, '用户改动');
  assert.equal((await sync({ ...w, report, component: 'both' })).exitCode, 10);
});

test('合并冲突保留现场，人工修复后resume完成', async t => {
  const { sync } = await import('../scripts/lib/sync.mjs');
  const { checkUpstreams } = await import('../scripts/lib/report.mjs');
  const w = await workspace(t);
  await w.writeFile(`${w.root}/core.txt`, '公司修改\n'); w.git(w.root, 'add', '.'); w.git(w.root, 'commit', '-m', '公司修改');
  await w.writeFile(`${w.upstream}/core.txt`, '上游修改\n'); w.git(w.upstream, 'add', '.'); w.git(w.upstream, 'commit', '-m', '上游修改');
  const report = await checkUpstreams(w);
  const conflict = await sync({ ...w, report, component: 'magpie' });
  assert.equal(conflict.exitCode, 12, JSON.stringify(conflict)); assert.deepEqual(conflict.conflicts.magpie, ['core.txt']);
  assert.ok((await w.readFile(`${conflict.worktrees.magpie}/core.txt`, 'utf8')).includes('<<<<<<<'));
  await w.writeFile(`${conflict.worktrees.magpie}/core.txt`, '人工解决\n'); w.git(conflict.worktrees.magpie, 'add', 'core.txt'); w.git(conflict.worktrees.magpie, 'commit', '-m', '解决冲突');
  await w.writeFile(`${w.upstream}/later.txt`, '上游随后前进'); w.git(w.upstream, 'add', '.'); w.git(w.upstream, 'commit', '-m', '后续上游提交');
  const now = Date.now;
  let resumed;
  try {
    Date.now = () => now() + 25 * 3_600_000;
    resumed = await sync({ ...w, report, component: 'magpie', resume: true });
  } finally { Date.now = now; }
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed)); assert.equal(resumed.status, 'complete');
  assert.equal(resumed.proposedLock.magpie.commit, report.upstreams.magpie.commit);
});

test('Nikou冲突期间人工修改Magpie拟定锁必须保留并拒绝恢复', async t => {
  const { sync } = await import('../scripts/lib/sync.mjs');
  const { checkUpstreams } = await import('../scripts/lib/report.mjs');
  const w = await workspace(t);
  await w.writeFile(`${w.nikouDir}/core.txt`, '公司Nikou修改'); w.git(w.nikouDir, 'add', '.'); w.git(w.nikouDir, 'commit', '-m', '公司修改');
  await w.writeFile(`${w.upstream}/core.txt`, '上游修改'); w.git(w.upstream, 'add', '.'); w.git(w.upstream, 'commit', '-m', '上游修改');
  const report = await checkUpstreams(w);
  const conflict = await sync({ ...w, report, component: 'both' });
  assert.equal(conflict.status, 'conflict');
  const lockFile = path.join(conflict.worktrees.magpie, 'company/upstreams.lock.json');
  const userLock = '人工锁修改'; await w.writeFile(lockFile, userLock);
  await w.writeFile(`${conflict.worktrees.nikou}/core.txt`, '解决'); w.git(conflict.worktrees.nikou, 'add', '.'); w.git(conflict.worktrees.nikou, 'commit', '-m', '解决');
  assert.equal((await sync({ ...w, report, component: 'both', resume: true })).exitCode, 10);
  assert.equal(await w.readFile(lockFile, 'utf8'), userLock);
});

test('仅同步Nikou隔离仓库历史，原锁不变且拟定锁记录实际提交', async t => {
  const { sync } = await import('../scripts/lib/sync.mjs');
  const { checkUpstreams } = await import('../scripts/lib/report.mjs');
  const w = await workspace(t);
  const before = await w.readFile(`${w.root}/company/upstreams.lock.json`);
  await w.writeFile(`${w.upstream}/package.json`, JSON.stringify({ name: 'nikou-cli', version: '1.1.0' }));
  w.git(w.upstream, 'add', '.'); w.git(w.upstream, 'commit', '-m', '包更新');
  const report = await checkUpstreams(w);
  const result = await sync({ ...w, report, component: 'nikou' });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.proposedLock.magpie.commit, w.lock.magpie.commit);
  assert.equal(result.proposedLock.nikou.version, '1.1.0');
  assert.equal(result.proposedLock.nikou.effectiveCommit, w.git(result.worktrees.nikou, 'rev-parse', 'HEAD'));
  assert.notEqual(w.git(result.worktrees.magpie, 'rev-parse', '--git-common-dir'), w.git(result.worktrees.nikou, 'rev-parse', '--git-common-dir'));
  assert.deepEqual(await w.readFile(`${w.root}/company/upstreams.lock.json`), before);
  assert.equal(w.git(w.nikouDir, 'rev-parse', 'HEAD'), w.lock.nikou.effectiveCommit);
});

test('不同候选的仓库占用锁拒绝执行，dry-run仍不写状态', async t => {
  const { sync } = await import('../scripts/lib/sync.mjs');
  const { checkUpstreams } = await import('../scripts/lib/report.mjs');
  const w = await workspace(t);
  await w.writeFile(`${w.upstream}/new.txt`, '变更'); w.git(w.upstream, 'add', '.'); w.git(w.upstream, 'commit', '-m', '更新');
  const report = await checkUpstreams(w);
  const lockFile = `${w.root}/.git/company-integration.lock`;
  await w.writeFile(lockFile, JSON.stringify({ integrationId: 'other', pid: 99999 }));
  assert.equal((await sync({ ...w, report, component: 'magpie' })).exitCode, 10);
  assert.equal(await w.readFile(lockFile, 'utf8'), JSON.stringify({ integrationId: 'other', pid: 99999 }));
  assert.equal((await sync({ ...w, report, component: 'magpie', dryRun: true })).exitCode, 0);
  await assert.rejects(access(`${w.root}/.git/company-integrations`));
});

test('已有空集成目录不允许替换为目录链接绕过路径边界', async t => {
  const { sync } = await import('../scripts/lib/sync.mjs');
  const { checkUpstreams } = await import('../scripts/lib/report.mjs');
  const { symlink } = await import('node:fs/promises');
  const w = await workspace(t);
  await w.writeFile(`${w.upstream}/new.txt`, '变更'); w.git(w.upstream, 'add', '.'); w.git(w.upstream, 'commit', '-m', '更新');
  const report = await checkUpstreams(w);
  const outside = `${w.dir}/outside`; await mkdir(outside);
  await symlink(outside, `${w.dir}/.company-integrations`, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await sync({ ...w, report, component: 'magpie' });
  assert.equal(result.exitCode, 2, JSON.stringify(result));
  await assert.rejects(access(`${outside}/${result.integrationId}/magpie`));
});

test('带注释tag解析到提交且移动tag使旧报告失效', async t => {
  const { sync } = await import('../scripts/lib/sync.mjs');
  const { checkUpstreams } = await import('../scripts/lib/report.mjs');
  const w = await workspace(t);
  w.git(w.upstream, 'tag', '-a', 'v1.0.0', '-m', '稳定标签');
  const policy = structuredClone(w.policy); policy.magpie.channels.stable = 'refs/tags/v1.0.0';
  const report = await checkUpstreams({ ...w, policy });
  assert.equal(report.upstreams.magpie.commit, w.lock.magpie.commit); assert.equal(report.changed, false);
  await w.writeFile(`${w.upstream}/new.txt`, '新提交'); w.git(w.upstream, 'add', '.'); w.git(w.upstream, 'commit', '-m', '新提交');
  w.git(w.upstream, 'tag', '-f', '-a', 'v1.0.0', '-m', '移动标签');
  assert.equal((await sync({ ...w, policy, report, component: 'magpie' })).exitCode, 2);
});
