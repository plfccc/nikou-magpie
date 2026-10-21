import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadContext, digest, allowedSource, IntegrationError } from './lock.mjs';
import { canonical } from './report.mjs';
import { dirty, git, head } from './git.mjs';
import { runProcess, npmCommand } from './process.mjs';

export const fingerprint = value => digest(canonical(value));
export function sealEvidence(value) { const { evidenceSha256, evidenceFile, ...body } = value; return { ...body, evidenceSha256: fingerprint(body) }; }
export function checkEvidence(value, profile) {
  if (!value || value.profile !== profile || sealEvidence(value).evidenceSha256 !== value.evidenceSha256 || value.exitCode !== 0 || value.releaseEligible !== true) throw new IntegrationError(15, `缺少有效且可发布的${profile}验收证据`);
}
export async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
export async function writeJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); }
export function reportRoot(ctx) { return path.join(ctx.root, 'artifacts', 'company'); }
export async function safeDirectory(base, target) {
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new IntegrationError(2, '产物路径越过受管目录');
  for (const part of ['', ...relative.split(path.sep)].filter((v, i) => v || !i)) {
    const check = part ? (base = path.join(base, part)) : base;
    try { if ((await lstat(check)).isSymbolicLink()) throw new IntegrationError(2, '产物路径含符号链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export async function sourceContext(options, { allowDirty = false, exact = true } = {}) {
  const ctx = await loadContext({ ...options, mode: 'source' });
  allowedSource(ctx.policy, 'magpie', ctx.lock.magpie.repository); allowedSource(ctx.policy, 'nikou', ctx.lock.nikou.repository);
  const sha = await head(ctx.root, ctx.run);
  let nikouSha;
  try { nikouSha = await head(ctx.nikouDir, ctx.run); } catch { throw new IntegrationError(11, 'Nikou源码不可访问'); }
  for (const [directory, upstream] of [[ctx.root, ctx.lock.magpie.commit], [ctx.nikouDir, ctx.lock.nikou.commit]]) {
    const top = await realpath(path.resolve(await git(directory, ['rev-parse', '--show-toplevel'], ctx.run)));
    if (top !== await realpath(directory)) throw new IntegrationError(11, '构建必须使用独立Git仓库根目录');
    const ancestor = await git(directory, ['merge-base', '--is-ancestor', upstream, 'HEAD'], ctx.run, { allowFailure: true });
    if (ancestor.exitCode !== 0) throw new IntegrationError(11, '源码不包含锁定的上游提交');
  }
  if (exact && nikouSha !== ctx.lock.nikou.effectiveCommit) throw new IntegrationError(11, 'Nikou源码HEAD不等于effectiveCommit');
  let dependency;
  try { dependency = digest(await readFile(path.join(ctx.nikouDir, 'package-lock.json'))); } catch { throw new IntegrationError(11, 'Nikou依赖锁不可访问'); }
  if (dependency !== ctx.lock.nikou.dependencyLock.sha256) throw new IntegrationError(15, 'Nikou依赖锁摘要不符');
  const pkg = await json(path.join(ctx.nikouDir, 'package.json'));
  if (pkg.name !== ctx.lock.nikou.package || pkg.version !== ctx.lock.nikou.version) throw new IntegrationError(15, 'Nikou源码包元数据不符');
  const status = {};
  for (const [name, dir] of [['magpie', ctx.root], ['nikou', ctx.nikouDir]]) {
    const tracked = await git(dir, ['diff', '--binary', 'HEAD'], ctx.run);
    const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], ctx.run);
    const bytes = [];
    for (const file of untracked.split('\0').filter(Boolean)) {
      const location = path.resolve(dir, file);
      if (!location.startsWith(`${dir}${path.sep}`)) throw new IntegrationError(2, '未跟踪文件路径越界');
      if ((await lstat(location)).isSymbolicLink()) throw new IntegrationError(10, '源码含未跟踪链接，拒绝读取外部内容');
      bytes.push(`${file}:${digest(await readFile(location))}`);
    }
    status[name] = { dirty: await dirty(dir, ctx.run), sha256: digest(`${tracked}\n${bytes.join('\n')}`) };
  }
  const isDirty = Object.values(status).some(s => s.dirty);
  if (isDirty && !allowDirty) throw new IntegrationError(10, '构建/正式验收要求两个源码工作树干净');
  return { ...ctx, package: pkg, provenance: { root: ctx.root, nikouDir: ctx.nikouDir, magpieUpstreamCommit: ctx.lock.magpie.commit, magpieCompanyCommit: sha, nikouUpstreamCommit: ctx.lock.nikou.commit, nikouEffectiveCommit: nikouSha, lockSha256: digest(ctx.lockBytes), dirty: isDirty, workingTrees: status } };
}
export async function sandbox(base) {
  // Windows 的深层候选目录会触发 ENAMETOOLONG；允许维护脚本把临时隔离目录放到短路径。
  const sandboxRoot = process.env.NIKOU_SANDBOX_ROOT || base;
  await mkdir(sandboxRoot, { recursive: true }); const dir = await mkdtemp(path.join(sandboxRoot, 'sandbox-'));
  for (const name of ['home', 'appdata', 'localappdata', 'tmp']) await mkdir(path.join(dir, name));
  const gitConfig = path.join(dir, 'gitconfig'); await writeFile(gitConfig, '');
  const env = { ...process.env, HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'), APPDATA: path.join(dir, 'appdata'), LOCALAPPDATA: path.join(dir, 'localappdata'), TMP: path.join(dir, 'tmp'), TEMP: path.join(dir, 'tmp'), GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  // 复用上游唯一的 Agent 环境清单，新增引擎时无需维护第二份列表。
  const source = await readFile(new URL('../../../internal/agentenv/agentenv.go', import.meta.url), 'utf8');
  const variables = source.match(/var Vars = \[\]string\{([\s\S]*?)\n\}/)?.[1];
  if (!variables) throw new IntegrationError(14, '无法读取 Agent 环境隔离清单');
  for (const [, key] of variables.matchAll(/"([A-Z][A-Z0-9_]*)"/g)) delete env[key];
  // 工具链缓存可复用，用户配置根和凭据环境不能继承到验收进程。
  for (const key of Object.keys(env)) {
    if (/(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key) || /^(?:CODEX|CLAUDE|KIRO|KIMI|GEMINI|GROK|HERMES|DSH|COPILOT|PI_CODING_AGENT|OMP|CODEBUDDY|NIKOU).*?(?:HOME|DIR|PATH)$/i.test(key)) delete env[key];
  }
  Object.assign(env, { XDG_CONFIG_HOME: path.join(dir, 'home', '.config'), XDG_DATA_HOME: path.join(dir, 'home', '.local', 'share'), XDG_STATE_HOME: path.join(dir, 'home', '.local', 'state'), XDG_CACHE_HOME: path.join(dir, 'home', '.cache'), CODEX_HOME: path.join(dir, 'home', '.codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'home', '.claude') });
  return { dir, env };
}
export async function command(ctx, checks, label, spec, env, required = true) {
  const startedAt = new Date().toISOString();
  const progressFile = process.env.NIKOU_MAINTENANCE_PROGRESS_FILE;
  const progress = async status => {
    if (progressFile) await writeJson(progressFile, { stage: label, status, startedAt, updatedAt: new Date().toISOString(), completedChecks: checks.length });
  };
  await progress('running');
  const result = await (ctx.run ?? runProcess)({ timeoutMs: 600_000, ...spec, env: { ...env, ...(spec.env ?? {}) } });
  const entry = { name: label, status: result.exitCode === 0 ? 'pass' : 'fail', file: spec.file, args: spec.args, cwd: spec.cwd, ...result };
  checks.push(entry);
  await progress(entry.status);
  if (required && result.exitCode !== 0) throw new IntegrationError(14, `${label}失败，子进程退出码${result.exitCode}`, 'COMMAND_FAILED');
  return result;
}
export function npm(ctx, args, cwd) {
  const npmCli = ctx.npmCli ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return npmCommand({ nodeExecutable: process.execPath, npmCli, args, cwd, timeoutMs: 600_000 });
}
export async function filesUnder(root) {
  const files = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new IntegrationError(15, `资产不能包含符号链接：${file}`);
      if (entry.isDirectory()) await visit(file); else if (entry.isFile()) files.push(file.split(path.sep).join('/'));
    }
  }
  await visit(''); return files.sort();
}
export async function asset(file, base, role) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new IntegrationError(15, '资产必须是常规文件');
  const bytes = await readFile(file); return { path: path.relative(base, file).split(path.sep).join('/'), role, size: bytes.length, sha256: digest(bytes) };
}
export async function validateAssets(build) {
  if (!build || build.exitCode !== 0 || !Array.isArray(build.assets) || !build.assets.length) throw new IntegrationError(15, '缺少构建清单');
  for (const item of build.assets) {
    if (typeof item.path !== 'string' || !item.path.startsWith('assets/') || item.path.includes('\\') || !/^[0-9a-f]{64}$/.test(item.sha256 ?? '') || !Number.isSafeInteger(item.size) || item.size < 0) throw new IntegrationError(15, '资产路径或摘要格式无效');
    const target = path.resolve(build.buildDir, item.path);
    await safeDirectory(build.buildDir, target);
    let actual; try { actual = await asset(target, build.buildDir, item.role); } catch { throw new IntegrationError(15, `资产缺失或不可读取：${item.path}`); }
    if (actual.sha256 !== item.sha256 || actual.size !== item.size) throw new IntegrationError(15, `资产摘要不符：${item.path}`);
  }
  const actualPaths = (await filesUnder(path.join(build.buildDir, 'assets'))).map(p => `assets/${p}`);
  if (new Set(build.assets.map(a => a.path)).size !== build.assets.length || fingerprint(actualPaths) !== fingerprint(build.assets.map(a => a.path).sort())) throw new IntegrationError(15, '资产目录包含清单外文件或重复资产');
}
export async function snapshot(ctx, source, target) {
  await mkdir(target, { recursive: true });
  const files = (await git(source, ['ls-files', '-z'], ctx.run)).split('\0').filter(Boolean);
  for (const name of files) {
    const from = path.resolve(source, name), to = path.resolve(target, name);
    if (!from.startsWith(`${source}${path.sep}`) || !to.startsWith(`${target}${path.sep}`) || (await lstat(from)).isSymbolicLink()) throw new IntegrationError(2, '源码快照包含越界路径或符号链接');
    await mkdir(path.dirname(to), { recursive: true }); await cp(from, to, { errorOnExist: true, force: false });
  }
}
