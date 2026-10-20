import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadContext, allowedSource, digest, failure, IntegrationError } from './lock.mjs';
import { head, resolveRemote } from './git.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sealReport(report) {
  const { reportId, summarySha256, ...body } = report;
  const summary = digest(canonical(body));
  return { ...body, reportId: summary.slice(0, 24), summarySha256: summary };
}
export function validateReport(report, ctx, { allowExpired = false } = {}) {
  if (!report || report.schemaVersion !== 1 || !/^[a-f0-9]{24}$/.test(report.reportId ?? '') || sealReport(report).summarySha256 !== report.summarySha256 || report.reportId !== report.summarySha256.slice(0, 24)) throw new IntegrationError(2, '候选报告摘要不符，请重新查询');
  const age = Date.now() - Date.parse(report.createdAt);
  if (!Number.isFinite(age) || age < -60_000 || (!allowExpired && age > (ctx.policy.reportMaxAgeHours ?? 24) * 3_600_000)) throw new IntegrationError(2, '候选报告已过期，请重新查询');
  if (report.lockSha256 !== digest(ctx.lockBytes) || report.policySha256 !== digest(ctx.policyBytes) || report.root !== ctx.root) throw new IntegrationError(2, '候选报告的锁、策略或工作区已变化');
}
export async function writeReport(file, report) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
}
export async function checkUpstreams(options = {}) {
  try {
    const ctx = await loadContext(options);
    const channel = options.channel ?? 'stable';
    if (channel !== 'stable') throw new IntegrationError(2, '仅支持stable通道');
    const upstreams = {};
    for (const component of ['magpie', 'nikou']) {
      if (component === 'nikou' && ctx.lock.nikou.mode === 'artifact') {
        upstreams.nikou = { mode: 'artifact', version: ctx.lock.nikou.version, changed: false }; continue;
      }
      const source = allowedSource(ctx.policy, component, ctx.lock[component].repository);
      const workspace = component === 'magpie' ? ctx.root : ctx.nikouDir;
      const ref = source.channels?.[channel];
      upstreams[component] = { repository: source.repository, ref, workspace, commit: await resolveRemote(ctx.root, source.repository, ref, ctx.run), baseCommit: await head(workspace, ctx.run), lockedCommit: ctx.lock[component].commit };
    }
    const report = sealReport({ schemaVersion: 1, exitCode: 0, root: ctx.root, baseCommit: upstreams.magpie.baseCommit, createdAt: new Date().toISOString(), channel, lockSha256: digest(ctx.lockBytes), policySha256: digest(ctx.policyBytes), upstreams, changed: Object.values(upstreams).some(u => u.commit && u.commit !== u.lockedCommit) });
    if (options.out) await writeReport(path.resolve(ctx.root, options.out), report);
    return report;
  } catch (error) { return failure(error); }
}
