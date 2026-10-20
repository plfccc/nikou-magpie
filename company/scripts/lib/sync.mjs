import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadContext, sha, allowedSource, digest, failure, IntegrationError } from './lock.mjs';
import { git, head, dirty, resolveRemote } from './git.mjs';
import { validateReport } from './report.mjs';

export function planSync({ component, baseCommit, currentCommit, dirty: isDirty, lockedUpstreams, candidateUpstreams }) {
  const reject = exitCode => ({ ok: false, exitCode, changedComponents: [], actions: [] });
  if (isDirty) return reject(10);
  if (!['magpie', 'nikou', 'both'].includes(component) || !sha(baseCommit) || baseCommit !== currentCommit) return reject(2);
  const selected = component === 'both' ? ['magpie', 'nikou'] : [component];
  if (selected.some(c => !sha(lockedUpstreams?.[c]) || !sha(candidateUpstreams?.[c]))) return reject(2);
  const changedComponents = selected.filter(c => lockedUpstreams[c] !== candidateUpstreams[c]);
  return { ok: true, exitCode: 0, changedComponents, actions: changedComponents.map(component => ({ component, action: 'merge', commit: candidateUpstreams[component] })) };
}

async function commonDir(cwd, run) { return realpath(path.resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir'], run))); }
async function readState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function saveState(file, state) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
  await rename(temp, file);
}
async function verifyManagedPaths(root, directory, worktrees) {
  const base = path.join(path.dirname(root), '.company-integrations');
  for (const entry of [base, directory, ...Object.values(worktrees)]) {
    if (!entry.startsWith(`${base}${path.sep}`) && entry !== base) throw new IntegrationError(2, '集成目录越过受管边界');
    try { if ((await lstat(entry)).isSymbolicLink()) throw new IntegrationError(2, '集成路径包含目录链接，拒绝写入'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function acquireLocks(directories, integrationId) {
  const held = [];
  try {
    for (const dir of [...new Set(directories)].sort()) {
      const file = path.join(dir, 'company-integration.lock');
      const fd = await open(file, 'wx').catch(error => { if (error.code === 'EEXIST') throw new IntegrationError(10, `已有同步任务占用仓库锁：${file}`); throw error; });
      held.push({ file, fd }); await fd.writeFile(JSON.stringify({ integrationId, pid: process.pid, createdAt: new Date().toISOString() }));
    }
    return async () => { for (const item of held.reverse()) { await item.fd.close(); await rm(item.file); } };
  } catch (error) { for (const item of held.reverse()) { await item.fd.close(); await rm(item.file); } throw error; }
}
async function verifyWorktree(cwd, expected, branch, run) {
  if (await commonDir(cwd, run) !== expected || await realpath(await git(cwd, ['rev-parse', '--show-toplevel'], run)) !== await realpath(cwd) || await git(cwd, ['symbolic-ref', '--short', 'HEAD'], run) !== branch) throw new IntegrationError(2, '候选工作树路径、仓库或分支已变化，保留现场');
}
async function conflicts(cwd, run) {
  const value = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], run);
  return value ? value.split('\0').filter(Boolean) : [];
}
async function isAncestor(cwd, before, after, run) {
  const result = await git(cwd, ['merge-base', '--is-ancestor', before, after], run, { allowFailure: true });
  if (result.exitCode > 1) throw new IntegrationError(11, result.stderr || '无法校验提交祖先');
  return result.exitCode === 0;
}

export async function sync(options = {}) {
  let release;
  let state;
  try {
    const ctx = await loadContext(options);
    const { root, nikouDir, lock, policy, run, report } = ctx;
    if (await dirty(root, run)) throw new IntegrationError(10, '公司工作树存在未提交改动');
    const component = options.component;
    if (!['magpie', 'nikou', 'both'].includes(component)) throw new IntegrationError(2, '必须选择magpie、nikou或both');
    if (lock.nikou.mode !== 'source' && component !== 'magpie') throw new IntegrationError(11, 'Nikou源码来源未验证');
    // 摘要和目录身份先校验，只有持久化现场允许放宽报告时效。
    validateReport(report, ctx, { allowExpired: Boolean(options.resume) });
    const saved = options.resume ? await readState(path.join(await commonDir(root, run), 'company-integrations', `${report.reportId}-${component}.json`)) : null;
    if (options.resume && (!saved || saved.summarySha256 !== report?.summarySha256)) throw new IntegrationError(2, '恢复必须使用已保存且摘要一致的候选报告');
    validateReport(report, ctx, { allowExpired: Boolean(saved) });
    const selected = component === 'both' ? ['magpie', 'nikou'] : [component];
    const lockedUpstreams = { magpie: lock.magpie.commit, nikou: lock.nikou.commit };
    const candidateUpstreams = Object.fromEntries(selected.map(c => [c, report.upstreams?.[c]?.commit]));
    const plan = planSync({ component, baseCommit: report.baseCommit, currentCommit: await head(root, run), dirty: false, lockedUpstreams, candidateUpstreams });
    if (!plan.ok) throw new IntegrationError(plan.exitCode, '公司base或候选提交无效，请重新查询');
    for (const c of selected) {
      const u = report.upstreams[c]; const workspace = c === 'magpie' ? root : nikouDir;
      const source = allowedSource(policy, c, u.repository);
      if (u.lockedCommit !== lock[c].commit || u.workspace !== workspace || u.ref !== source.channels?.[report.channel] || u.baseCommit !== await head(workspace, run)) throw new IntegrationError(2, `${c}来源或公司base已变化，请重新查询`);
      if (c === 'nikou' && await dirty(workspace, run)) throw new IntegrationError(10, 'Nikou公司工作树存在未提交改动');
      if (!saved && await resolveRemote(root, u.repository, u.ref, run) !== u.commit) throw new IntegrationError(2, `${c}候选引用已移动，请重新查询`);
    }
    const integrationId = `${report.reportId}-${component}`;
    const common = { magpie: await commonDir(root, run) };
    if (plan.changedComponents.includes('nikou')) common.nikou = await commonDir(nikouDir, run);
    const directory = path.join(path.dirname(root), '.company-integrations', integrationId);
    const components = plan.changedComponents.length ? [...new Set(['magpie', ...plan.changedComponents])] : [];
    const branches = Object.fromEntries(components.map(c => [c, `integrate/${integrationId}/${c}`]));
    const worktrees = Object.fromEntries(components.map(c => [c, path.join(directory, c)]));
    await verifyManagedPaths(root, directory, worktrees);
    const initial = { exitCode: 0, integrationId, reportId: report.reportId, component, summarySha256: report.summarySha256, status: plan.changedComponents.length ? 'planned' : 'unchanged', worktrees, branches, conflicts: {}, proposedLock: structuredClone(lock), actions: plan.actions };
    if (options.dryRun || !components.length) return { ...initial, dryRun: Boolean(options.dryRun), commands: components.map(c => ({ file: 'git', args: ['worktree', 'add', '-b', branches[c], worktrees[c], report.upstreams[c].baseCommit] })).concat(plan.actions.map(a => ({ file: 'git', args: ['merge', '--no-edit', '--', a.commit], cwd: worktrees[a.component] }))) };
    release = await acquireLocks(Object.values(common), integrationId);
    await verifyManagedPaths(root, directory, worktrees);
    // 获锁后再次检查，避免等待锁期间调用方更新公司分支。
    for (const c of selected) if (await head(c === 'magpie' ? root : nikouDir, run) !== report.upstreams[c].baseCommit || await dirty(c === 'magpie' ? root : nikouDir, run)) throw new IntegrationError(10, '获得锁后公司工作树发生变化');
    const statesDir = path.join(common.magpie, 'company-integrations');
    await mkdir(statesDir, { recursive: true });
    const statePath = path.join(statesDir, `${integrationId}.json`);
    state = await readState(statePath);
    if (state && (state.summarySha256 !== report.summarySha256 || JSON.stringify(state.worktrees) !== JSON.stringify(worktrees) || JSON.stringify(state.branches) !== JSON.stringify(branches))) throw new IntegrationError(2, '已有候选状态与报告不符，保留现场');
    if (!state) { state = { ...initial, status: 'integrating', completed: {}, created: {} }; await saveState(statePath, state); }
    for (const c of components) {
      const workspace = c === 'magpie' ? root : nikouDir;
      const expected = common[c] ?? common.magpie;
      if (!state.created[c]) {
        await mkdir(directory, { recursive: true });
        // 不复用同名目录或分支，避免接管其他会话。
        await git(workspace, ['worktree', 'add', '-b', branches[c], worktrees[c], report.upstreams[c].baseCommit], run);
        state.created[c] = true; await saveState(statePath, state);
      }
      await verifyWorktree(worktrees[c], expected, branches[c], run);
      if (state.completed[c]) {
        if (await head(worktrees[c], run) !== state.completed[c]) throw new IntegrationError(2, `${c}已完成候选HEAD发生变化，保留现场`);
        const status = await git(worktrees[c], ['status', '--porcelain'], run);
        if (status && (state.status !== 'complete' || c !== 'magpie' || status.split('\n').some(line => line.slice(3) !== 'company/upstreams.lock.json'))) throw new IntegrationError(10, `${c}候选工作树存在用户修改`);
        if (state.status === 'complete' && c === 'magpie' && digest(await readFile(path.join(worktrees.magpie, 'company/upstreams.lock.json'))) !== state.proposedLockSha256) throw new IntegrationError(15, '拟定锁被修改，保留现场');
        continue;
      }
      const unresolved = await conflicts(worktrees[c], run);
      if (unresolved.length) {
        state.conflicts[c] = unresolved; state.status = 'conflict'; state.exitCode = 12;
        await saveState(statePath, state); return state;
      }
      if (state.status === 'conflict' && !options.resume) throw new IntegrationError(12, '冲突已处理后请显式使用--resume');
      if (await dirty(worktrees[c], run)) throw new IntegrationError(10, `${c}候选工作树存在未提交修改，请保留并人工处理`);
      if (plan.changedComponents.includes(c)) {
        const target = report.upstreams[c].commit;
        if (!await isAncestor(worktrees[c], report.upstreams[c].baseCommit, 'HEAD', run)) throw new IntegrationError(2, `${c}候选分支不再包含公司base，保留现场`);
        const object = await git(worktrees[c], ['cat-file', '-e', `${target}^{commit}`], run, { allowFailure: true });
        if (object.exitCode) await git(worktrees[c], ['fetch', '--no-tags', '--', report.upstreams[c].repository, target], run);
        const alreadyMerged = await isAncestor(worktrees[c], target, 'HEAD', run);
        if (!alreadyMerged) {
          if (await head(worktrees[c], run) !== report.upstreams[c].baseCommit) throw new IntegrationError(2, `${c}候选HEAD发生未识别变化，保留现场`);
          await git(worktrees[c], ['fetch', '--no-tags', '--', report.upstreams[c].repository, target], run);
          const result = await git(worktrees[c], ['merge', '--no-edit', '--', target], run, { allowFailure: true });
          if (result.exitCode) {
            const files = await conflicts(worktrees[c], run);
            if (!files.length) throw new IntegrationError(11, result.stderr || 'Git合并失败');
            state.conflicts[c] = files; state.upstreamChanges = { ...state.upstreamChanges, [c]: await git(worktrees[c], ['diff', '--name-status', report.upstreams[c].lockedCommit, target], run) }; state.status = 'conflict'; state.exitCode = 12;
            await saveState(statePath, state); return state;
          }
        }
        state.proposedLock[c].commit = target;
        if (c === 'nikou') {
          state.proposedLock.nikou.effectiveCommit = await head(worktrees.nikou, run);
          state.proposedLock.nikou.dependencyLock.sha256 = digest(await readFile(path.join(worktrees.nikou, 'package-lock.json')));
          const pkg = JSON.parse(await readFile(path.join(worktrees.nikou, 'package.json'), 'utf8'));
          if (pkg.name !== lock.nikou.package) throw new IntegrationError(15, 'Nikou候选包身份变化');
          state.proposedLock.nikou.version = pkg.version;
        }
      }
      state.completed[c] = await head(worktrees[c], run); delete state.conflicts[c]; await saveState(statePath, state);
    }
    const proposedBytes = `${JSON.stringify(state.proposedLock, null, 2)}\n`;
    const proposedPath = path.join(worktrees.magpie, 'company/upstreams.lock.json');
    if (state.status !== 'complete') { await mkdir(path.dirname(proposedPath), { recursive: true }); await writeFile(proposedPath, proposedBytes); }
    state.proposedLockSha256 = digest(proposedBytes); state.proposedLockPath = proposedPath; state.status = 'complete'; state.exitCode = 0;
    await saveState(statePath, state); return state;
  } catch (error) { return { ...(state ?? {}), ...failure(error), status: error.exitCode === 12 ? 'conflict' : 'rejected' }; }
  finally { if (release) await release(); }
}
