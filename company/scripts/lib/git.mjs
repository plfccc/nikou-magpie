import { runProcess } from './process.mjs';
import { IntegrationError, sha } from './lock.mjs';

export async function git(cwd, args, run = runProcess, { allowFailure = false } = {}) {
  const result = await run({ file: 'git', args: ['-c', 'core.quotepath=false', '-c', 'core.hooksPath=', ...args], cwd, timeoutMs: 60_000 });
  if (result.exitCode && !allowFailure) throw new IntegrationError(11, result.stderr.trim() || `Git执行失败：${args[0]}`, 'GIT_FAILED');
  return allowFailure ? result : result.stdout.trimEnd();
}

export const head = (cwd, run) => git(cwd, ['rev-parse', '--verify', 'HEAD'], run);
export const dirty = async (cwd, run) => Boolean(await git(cwd, ['status', '--porcelain', '--untracked-files=normal'], run));
export async function resolveRemote(cwd, repository, ref, run) {
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9_./-]+$/.test(ref ?? '') || ref.includes('..') || ref.includes('//')) throw new IntegrationError(2, 'policy必须指定完整且有效的branch/tag引用');
  const output = await git(cwd, ['ls-remote', '--exit-code', repository, ref, `${ref}^{}`], run);
  const rows = output.split('\n').map(row => row.split(/\s+/));
  const commit = (rows.find(row => row[1] === `${ref}^{}`) ?? rows.find(row => row[1] === ref))?.[0];
  if (!sha(commit)) throw new IntegrationError(11, `来源没有可解析引用：${ref}`, 'REF_UNAVAILABLE');
  return commit;
}
