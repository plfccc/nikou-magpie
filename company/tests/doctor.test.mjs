import test from 'node:test';
import assert from 'node:assert/strict';
import { workspace } from './fixtures/git/workspace.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('子进程保留空格中文参数并报告超时和缺工具', async () => {
  const module = await import('../scripts/lib/process.mjs').catch(() => ({}));
  assert.equal(typeof module.runProcess, 'function', '必须实现参数数组子进程执行器');
  const result = await module.runProcess({ file: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', '中文 空格'] });
  assert.equal(result.stdout, '中文 空格'); assert.equal(result.exitCode, 0);
  assert.equal((await module.runProcess({ file: 'missing-tool-for-test', args: [] })).exitCode, 127);
  assert.equal((await module.runProcess({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 })).timedOut, true);
});

test('源码诊断发现摘要错误且不改锁；artifact锁拒绝源码模式', async t => {
  const { doctor } = await import('../scripts/lib/doctor.mjs');
  const w = await workspace(t);
  const before = await w.readFile(`${w.root}/company/upstreams.lock.json`);
  const valid = await doctor({ ...w, tools: { go: false, bun: false } });
  assert.equal(valid.exitCode, 0, JSON.stringify(valid));
  await w.writeFile(`${w.nikouDir}/package-lock.json`, '变更');
  const bad = await doctor({ ...w, tools: { go: false, bun: false } });
  assert.equal(bad.exitCode, 15); assert.ok(bad.diagnostics.some(d => d.code === 'DEPENDENCY_DIGEST' && d.status === 'error'));
  assert.deepEqual(await w.readFile(`${w.root}/company/upstreams.lock.json`), before);
  const artifact = { ...w.lock, nikou: { mode: 'artifact', package: 'nikou-cli', version: '1.0.0', integrity: 'sha512-YWJj', sourceVerified: false } };
  assert.equal((await doctor({ ...w, lock: artifact, mode: 'source' })).exitCode, 11);
});

test('候选查询区分无变化与来源失败，锁字节保持原状', async t => {
  const { checkUpstreams } = await import('../scripts/lib/report.mjs');
  const w = await workspace(t);
  const before = await w.readFile(`${w.root}/company/upstreams.lock.json`);
  const report = await checkUpstreams(w);
  assert.equal(report.exitCode, 0); assert.equal(report.changed, false); assert.match(report.reportId, /^[a-f0-9]{24}$/);
  const denied = structuredClone(w.policy); denied.magpie.repository = `${w.dir}/not-allowed`;
  assert.equal((await checkUpstreams({ ...w, policy: denied })).exitCode, 11);
  const missing = structuredClone(w.policy); missing.magpie.repository = `${w.dir}/missing`; missing.magpie.allowedRepositories.push(missing.magpie.repository);
  assert.equal((await checkUpstreams({ ...w, policy: missing })).exitCode, 11);
  assert.deepEqual(await w.readFile(`${w.root}/company/upstreams.lock.json`), before);
});

test('真实CLI拒绝未知命令、重复参数和空壳构建，Windows npm使用node参数数组', async t => {
  const { npmCommand, runProcess } = await import('../scripts/lib/process.mjs');
  const w = await workspace(t);
  const cli = fileURLToPath(new URL('../scripts/integrate.mjs', import.meta.url));
  for (const args of [['install'], ['rollback'], ['install', '--manifest', 'relative', '--install-root', 'relative', '--offline'], ['migrate', 'unknown'], ['migrate', 'plan'], ['doctor', '--mode', 'latest'], ['doctor', '--json', '--json'], ['sync', '--component', 'both']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: w.root, env: w.env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 2, result.stderr || result.stdout); assert.equal(JSON.parse(result.stdout).exitCode, 2);
  }
  const npmCli = `${w.dir}/npm-cli.js`; await w.writeFile(npmCli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const result = await runProcess(npmCommand({ nodeExecutable: process.execPath, npmCli, args: ['中文 空格', '--version'], cwd: w.root }));
  assert.deepEqual(JSON.parse(result.stdout), ['中文 空格', '--version']);
  assert.throws(() => runProcess({ file: 'npm.cmd', args: [] }), /批处理/);
});

test('诊断检测脏目录与缺工具，报告包含逐项状态', async t => {
  const { doctor } = await import('../scripts/lib/doctor.mjs');
  const w = await workspace(t);
  await w.writeFile(`${w.root}/user.txt`, '用户修改');
  const result = await doctor({ ...w, tools: { go: false, bun: false } });
  assert.equal(result.exitCode, 10); assert.ok(result.diagnostics.some(d => d.code === 'WORKTREE' && d.status === 'error'));
  const missing = await doctor({ ...w, run: args => args.file === process.execPath ? Promise.resolve({ exitCode: 127, stdout: '', stderr: 'missing', timedOut: false }) : w.run(args) });
  assert.ok(missing.diagnostics.some(d => d.code === 'TOOL_NODE' && d.status === 'error'));
});
