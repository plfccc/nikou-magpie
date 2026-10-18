import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadContext, allowedSource, digest, failure } from './lock.mjs';
import { git, head, dirty } from './git.mjs';
import { runProcess } from './process.mjs';

export async function doctor(options = {}) {
  const diagnostics = [];
  let exitCode = 0;
  const add = (status, code, message, exit = 10) => { diagnostics.push({ status, code, message }); if (status === 'error' && !exitCode) exitCode = exit; };
  try {
    const ctx = await loadContext({ mode: 'source', ...options });
    const { root, nikouDir, lock, policy, run = runProcess } = ctx;
    const gitRoot = await realpath(await git(root, ['rev-parse', '--show-toplevel'], run));
    if (gitRoot !== root) add('error', 'GIT_ROOT', '必须在Git工作树根目录运行'); else add('ok', 'GIT_ROOT', root);
    add(await dirty(root, run) ? 'error' : 'ok', 'WORKTREE', await dirty(root, run) ? '工作树存在未提交改动' : '工作树干净');
    const remoteNames = (await git(root, ['remote'], run)).split('\n');
    const origin = remoteNames.includes('origin') ? await git(root, ['remote', 'get-url', 'origin'], run) : '';
    const upstream = remoteNames.includes('upstream') ? await git(root, ['remote', 'get-url', 'upstream'], run) : '';
    if (!origin || origin === lock.magpie.repository) add('warning', 'COMPANY_ORIGIN', '公司origin尚未配置，不能发布或推送官方来源'); else add('ok', 'COMPANY_ORIGIN', origin);
    add(upstream === lock.magpie.repository ? 'ok' : 'warning', 'UPSTREAM_REMOTE', upstream === lock.magpie.repository ? upstream : 'upstream未指向锁定来源');
    for (const component of ['magpie', 'nikou']) {
      if (component === 'nikou' && lock.nikou.mode === 'artifact') continue;
      allowedSource(policy, component, lock[component].repository); add('ok', `${component.toUpperCase()}_SOURCE`, lock[component].repository);
    }
    for (const [tool, expected, args] of [['node', policy.tools?.node, ['--version']], ['go', policy.tools?.go, ['version']], ['bun', policy.tools?.bun, ['--version']]]) {
      if (options.tools?.[tool] === false || !expected) continue;
      const result = await run({ file: tool === 'node' ? process.execPath : tool, args, cwd: root, timeoutMs: 10_000 });
      const actual = result.stdout.trim();
      add(result.exitCode === 0 && (tool === 'go' ? actual.includes(`go${expected} `) : actual.replace(/^v/, '') === expected) ? 'ok' : 'error', `TOOL_${tool.toUpperCase()}`, result.exitCode ? `${tool}不可用` : `${tool}: ${actual}，要求${expected}`);
    }
    add(String(policy.tools?.nodeAbi ?? process.versions.modules) === process.versions.modules ? 'ok' : 'error', 'NODE_ABI', `ABI ${process.versions.modules}`);
    if (lock.nikou.mode === 'source') {
      try { await access(nikouDir); } catch { add('error', 'SOURCE_UNAVAILABLE', 'Nikou源码目录不可访问', 11); return { exitCode, diagnostics }; }
      const nikouRoot = await realpath(await git(nikouDir, ['rev-parse', '--show-toplevel'], run));
      add(nikouRoot === await realpath(nikouDir) && await head(nikouDir, run) === lock.nikou.effectiveCommit ? 'ok' : 'error', 'SOURCE_COMMIT', '核对Nikou独立源码工作树与effectiveCommit', 11);
      const actual = digest(await readFile(path.join(nikouDir, lock.nikou.dependencyLock.path)));
      add(actual === lock.nikou.dependencyLock.sha256 ? 'ok' : 'error', 'DEPENDENCY_DIGEST', actual === lock.nikou.dependencyLock.sha256 ? '依赖锁摘要匹配' : '依赖锁摘要不匹配', 15);
      const pkg = JSON.parse(await readFile(path.join(nikouDir, 'package.json'), 'utf8'));
      add(pkg.name === lock.nikou.package && pkg.version === lock.nikou.version ? 'ok' : 'error', 'PACKAGE_METADATA', `源码包：${pkg.name}@${pkg.version}`, 15);
      add(await dirty(nikouDir, run) ? 'error' : 'ok', 'NIKOU_WORKTREE', await dirty(nikouDir, run) ? 'Nikou工作树有未提交改动' : 'Nikou工作树干净');
    }
    return { exitCode, diagnostics };
  } catch (error) { const result = failure(error); return { ...result, diagnostics: [...diagnostics, ...result.diagnostics] }; }
}
