import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { workspace } from './fixtures/git/workspace.mjs';
import { fakeBuild } from './fixtures/fake-build.mjs';

test('构建在调用工具前拒绝未验证来源、错误HEAD、依赖摘要和脏源码', async t => {
  const module = await import('../scripts/lib/build.mjs').catch(() => ({}));
  assert.equal(typeof module.build, 'function', '必须实现有来源门禁的构建');
  const w = await workspace(t); let calls = 0;
  const run = async args => { calls++; return w.run(args); };
  const artifact = { ...w.lock, nikou: { mode: 'artifact', package: 'nikou-cli', version: '1.0.0', integrity: 'sha512-YWJj', sourceVerified: false } };
  assert.equal((await module.build({ ...w, lock: artifact, run })).exitCode, 11); assert.equal(calls, 0);
  const badHead = structuredClone(w.lock); badHead.nikou.effectiveCommit = 'f'.repeat(40);
  assert.equal((await module.build({ ...w, lock: badHead })).exitCode, 11);
  await writeFile(`${w.nikouDir}/package-lock.json`, '摘要错误');
  assert.equal((await module.build(w)).exitCode, 15);
  await writeFile(`${w.nikouDir}/package-lock.json`, '{}\n');
  await writeFile(`${w.root}/dirty.txt`, '用户');
  assert.equal((await module.build(w)).exitCode, 10);
});

test('构建固定生产参数并记录私有Node、完整npm包和四种提交身份', async t => {
  const w = await fakeBuild(t);
  assert.ok(w.commands.some(c => c.file === 'go' && c.args.includes('github.com/tc-hib/go-winres@v0.3.3')));
  assert.ok(w.commands.some(c => c.file === 'go' && c.args.includes('production') && c.args.some(a => a.includes('-H windowsgui'))));
  assert.ok(w.commands.some(c => c.file === 'go' && c.args.some(a => a.includes('internal/update.CompanyMode=1'))));
  assert.ok(w.commands.some(c => c.args.includes('ci') && c.args.includes('--omit=dev')));
  assert.equal(w.built.provenance.nikouEffectiveCommit, w.lock.nikou.effectiveCommit);
  assert.equal(w.built.provenance.magpieCompanyCommit, w.git(w.root, 'rev-parse', 'HEAD'));
  assert.ok(w.built.assets.some(a => a.role === 'node-runtime'));
  assert.ok(w.built.assets.some(a => a.role === 'nikou-package'));
  assert.ok(await readFile(w.built.buildFile));
});

test('构建保留子进程失败退出码且不产出成功清单', async t => {
  const { build } = await import('../scripts/lib/build.mjs'); const w = await workspace(t);
  const run = async o => o.file === 'git' ? w.run(o) : ({ exitCode: 37, stdout: '', stderr: '工具失败', timedOut: false });
  const result = await build({ ...w, run, platform: 'windows', arch: 'amd64', hostPlatform: 'win32' });
  assert.notEqual(result.exitCode, 0); assert.ok(result.commands?.some(c => c.exitCode === 37));
});
