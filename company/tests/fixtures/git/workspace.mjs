import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), '维护 空格-'));
  const config = path.join(dir, 'empty.gitconfig');
  await writeFile(config, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (cwd, ...args) => {
    const p = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
    if (p.status !== 0) throw new Error(`${args.join(' ')}: ${p.stderr}`);
    return p.stdout.trim();
  };
  const upstream = path.join(dir, 'upstream');
  await mkdir(upstream);
  git(upstream, 'init', '-b', 'main');
  await writeFile(path.join(upstream, 'core.txt'), '原始\n');
  await writeFile(path.join(upstream, 'package.json'), JSON.stringify({ name: 'nikou-cli', version: '1.0.0' }));
  await writeFile(path.join(upstream, 'package-lock.json'), '{}\n');
  await writeFile(path.join(upstream, '.gitignore'), '/artifacts/\n/dist/\n/node_modules/\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', '基线');
  const commit = git(upstream, 'rev-parse', 'HEAD');
  const root = path.join(dir, 'company'); git(dir, 'clone', upstream, root);
  const nikouDir = path.join(dir, 'nikou'); git(dir, 'clone', upstream, nikouDir);
  const policy = { schemaVersion: 1, reportMaxAgeHours: 24, tools: { node: process.versions.node, nodeAbi: process.versions.modules }, magpie: { repository: upstream, allowedRepositories: [upstream], channels: { stable: 'refs/heads/main' } }, nikou: { repository: upstream, allowedRepositories: [upstream], workspace: nikouDir, channels: { stable: 'refs/heads/main' } } };
  const lock = { schemaVersion: 1, bridgeProtocol: 1, magpie: { repository: upstream, commit }, nikou: { mode: 'source', package: 'nikou-cli', version: '1.0.0', repository: upstream, commit, effectiveCommit: commit, sourceVerified: true, dependencyLock: { path: 'package-lock.json', sha256: createHash('sha256').update('{}\n').digest('hex') } } };
  await mkdir(path.join(root, 'company'));
  await mkdir(path.join(root, 'company/tests'));
  await writeFile(path.join(root, 'company/tests/fixture.test.mjs'), "import test from 'node:test'; test('临时项目测试', () => {});\n");
  await writeFile(path.join(root, 'company/upstreams.policy.json'), JSON.stringify(policy));
  await writeFile(path.join(root, 'company/upstreams.lock.json'), JSON.stringify(lock));
  git(root, 'add', '.'); git(root, 'commit', '-m', '公司配置');
  const { runProcess } = await import('../../../scripts/lib/process.mjs');
  const run = options => runProcess({ ...options, env });
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { dir, root, upstream, nikouDir, policy, lock, git, run, env, readFile, writeFile };
}
