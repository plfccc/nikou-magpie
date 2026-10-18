import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { workspace } from './fixtures/git/workspace.mjs';
import { fakeBuild } from './fixtures/fake-build.mjs';

test('源码验证允许本地脏状态但证据禁止发布，正式用途拒绝脏目录', async t => {
  const module = await import('../scripts/lib/verify.mjs').catch(() => ({}));
  assert.equal(typeof module.verify, 'function', '必须实现分层验证入口');
  const w = await workspace(t); await writeFile(`${w.root}/dirty.txt`, '开发');
  assert.equal((await module.verify({ ...w, profile: 'source' })).exitCode, 10);
  const run = o => o.file === 'git' ? w.run(o) : Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
  const evidence = await module.verify({ ...w, run, profile: 'source', allowDirty: true, npmCli: `${w.dir}/npm-cli.js` });
  assert.equal(evidence.exitCode, 0, JSON.stringify(evidence)); assert.equal(evidence.releaseEligible, false); assert.equal(evidence.provenance.dirty, true);
  assert.ok(evidence.checks.some(c => c.status === 'not-run'));
});

test('产物验证必须运行两个专用自检，缺自检或ABI错拒绝签发可发布证据', async t => {
  const { verify } = await import('../scripts/lib/verify.mjs'); const w = await fakeBuild(t);
  const valid = await verify({ ...w.options, profile: 'artifacts', build: w.built });
  assert.equal(valid.exitCode, 0, JSON.stringify(valid)); assert.equal(valid.releaseEligible, true);
  const missing = await verify({ ...w.options, profile: 'artifacts', build: w.built, run: o => o.file === 'git' ? w.run(o) : Promise.resolve({ exitCode: 2, stdout: '', stderr: '未知命令', timedOut: false }) });
  assert.equal(missing.exitCode, 14); assert.equal(missing.releaseEligible, false);
  const wrongAbi = await verify({ ...w.options, profile: 'artifacts', build: w.built, run: async o => { const r = await w.run(o); if (o.args.includes('integration-check')) r.stdout = JSON.stringify({ ok: true, protocol: 1, component: 'nikou', version: '1.0.0', nodeAbi: 'wrong' }); return r; } });
  assert.equal(wrongAbi.exitCode, 13);
});

test('资产变更、错误HEAD或不具备安装回滚证据拒绝验收', async t => {
  const { verify } = await import('../scripts/lib/verify.mjs'); const w = await fakeBuild(t);
  const exe = w.built.assets.find(a => a.role === 'magpie');
  const original = await readFile(`${w.built.buildDir}/${exe.path}`);
  await writeFile(`${w.built.buildDir}/${exe.path}`, '被替换');
  assert.equal((await verify({ ...w.options, profile: 'artifacts', build: w.built })).exitCode, 15);
  await writeFile(`${w.built.buildDir}/${exe.path}`, original);
  await writeFile(`${w.root}/new-company-file`, '公司提交'); w.git(w.root, 'add', '.'); w.git(w.root, 'commit', '-m', '公司提交后旧构建失效');
  assert.equal((await verify({ ...w.options, profile: 'artifacts', build: w.built })).exitCode, 15);
  assert.equal((await verify({ ...w.options, profile: 'install' })).exitCode, 16);
});
