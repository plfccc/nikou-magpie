import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { failure, IntegrationError, digest, sha } from './lock.mjs';
import { git } from './git.mjs';
import { checkEvidence, fingerprint, json, reportRoot, safeDirectory, sourceContext, validateAssets, writeJson } from './evidence.mjs';
import { loadBuild } from './verify.mjs';

export async function packageRelease(options = {}) {
  try {
    const ctx = await sourceContext(options); const build = await loadBuild(ctx, options);
    const version = options.version;
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || version !== build.companyVersion) throw new IntegrationError(2, '版本必须为x.y.z且与构建的公司版本一致');
    const reports = reportRoot(ctx);
    const evidence = options.artifactEvidence ?? await json(options.artifactEvidenceFile ?? path.join(reports, 'artifacts-evidence.json')).catch(() => null);
    checkEvidence(evidence, 'artifacts');
    if (evidence.buildSha256 !== build.evidenceSha256 || evidence.assetsSha256 !== fingerprint(build.assets) || fingerprint(evidence.provenance) !== fingerprint(build.provenance)) throw new IntegrationError(15, '资产验收证据未绑定当前构建');
    const releaseDir = path.join(reports, 'releases', version); await safeDirectory(ctx.root, releaseDir); await mkdir(path.dirname(releaseDir), { recursive: true }); await mkdir(releaseDir, { recursive: false });
    for (const item of build.assets) {
      const source = path.join(build.buildDir, item.path), target = path.join(releaseDir, item.path);
      await safeDirectory(releaseDir, target); await mkdir(path.dirname(target), { recursive: true }); await cp(source, target, { force: false, errorOnExist: true });
    }
    const manifest = {
      schemaVersion: 1, companyVersion: version, bridgeProtocol: ctx.lock.bridgeProtocol,
      magpieUpstreamCommit: build.provenance.magpieUpstreamCommit, magpieCompanyCommit: build.provenance.magpieCompanyCommit,
      nikouUpstreamCommit: build.provenance.nikouUpstreamCommit, nikouEffectiveCommit: build.provenance.nikouEffectiveCommit,
      lockSha256: build.provenance.lockSha256, buildSha256: build.evidenceSha256, artifactsEvidenceSha256: evidence.evidenceSha256,
      platform: build.platform, arch: build.arch, runtime: build.runtime, toolchain: build.toolchain,
      requirements: { nodeVersion: build.toolchain.node, nodeAbi: build.toolchain.nodeAbi, operatingSystem: 'windows', arch: 'amd64' },
      components: { magpie: { entry: build.assets.find(a => a.role === 'magpie').path }, nikou: { entry: build.runtime.entry, node: build.runtime.node, directory: build.runtime.directory, package: build.assets.find(a => a.role === 'nikou-package').path, version: ctx.lock.nikou.version } },
      assets: build.assets, packageSha256: fingerprint(build.assets), createdAt: new Date().toISOString()
    };
    await validateAssets({ exitCode: 0, buildDir: releaseDir, assets: manifest.assets });
    const current = await sourceContext(options);
    if (fingerprint(current.provenance) !== fingerprint(ctx.provenance)) throw new IntegrationError(15, '打包期间源码变化，拒绝签发发布清单');
    const manifestFile = path.join(releaseDir, 'release-manifest.json'); await writeJson(manifestFile, manifest);
    await writeFile(path.join(releaseDir, 'SHA256SUMS'), `${manifest.assets.map(a => `${a.sha256}  ${a.path}`).join('\n')}\n${digest(await readFile(manifestFile))}  release-manifest.json\n`);
    return { exitCode: 0, releaseDir, manifestFile, manifestSha256: digest(await readFile(manifestFile)), packageSha256: manifest.packageSha256, manifest };
  } catch (error) { return failure(error); }
}

export async function validateInstallEvidence({ manifestPath, installEvidenceFile, installEvidence }) {
  if (!manifestPath) throw new IntegrationError(16, '必须提供明确的最终manifest与安装/回滚证据');
  const manifest = await json(manifestPath); const directory = path.dirname(manifestPath);
  if (manifest.schemaVersion !== 1 || manifest.bridgeProtocol !== 1 || manifest.platform !== 'windows' || manifest.arch !== 'amd64' || !/^\d+\.\d+\.\d+$/.test(manifest.companyVersion ?? '') || ['magpieUpstreamCommit', 'magpieCompanyCommit', 'nikouUpstreamCommit', 'nikouEffectiveCommit'].some(key => !sha(manifest[key])) || !/^[0-9a-f]{64}$/.test(manifest.lockSha256 ?? '') || !Array.isArray(manifest.assets) || manifest.packageSha256 !== fingerprint(manifest.assets) || !manifest.runtime?.entry || !manifest.runtime?.node || !manifest.assets.some(a => a.path === manifest.runtime.node && a.role === 'node-runtime') || !manifest.assets.some(a => a.path === manifest.runtime.entry && a.role === 'nikou-runtime')) throw new IntegrationError(15, '最终发布清单无效');
  await validateAssets({ exitCode: 0, buildDir: directory, assets: manifest.assets });
  const manifestSha256 = digest(await readFile(manifestPath));
  let evidence;
  try { evidence = installEvidence ?? await json(installEvidenceFile); } catch { throw new IntegrationError(16, '缺少真实安装/回滚证据'); }
  if (evidence.schemaVersion !== 1 || evidence.profile !== 'install' || evidence.ok !== true || !Number.isFinite(Date.parse(evidence.createdAt)) || typeof evidence.transactionId !== 'string' || !evidence.transactionId || evidence.manifestSha256 !== manifestSha256 || (evidence.packageSha256 && evidence.packageSha256 !== manifest.packageSha256) || !Array.isArray(evidence.checks) || !evidence.checks.length || evidence.checks.some(c => c.status !== 'pass') || !evidence.checks.some(c => /install|安装/i.test(c.name)) || !evidence.checks.some(c => /rollback|回滚/i.test(c.name))) throw new IntegrationError(16, '安装/回滚证据不完整或未绑定确切最终包');
  return { manifest, evidence, manifestSha256, directory };
}

export async function releasePlan(options = {}) {
  try {
    const ctx = await sourceContext(options); const reports = reportRoot(ctx);
    const manifestPath = options.manifest ?? options.manifestPath ?? (options.version ? path.join(reports, 'releases', options.version, 'release-manifest.json') : undefined);
    const validated = await validateInstallEvidence({ manifestPath, installEvidenceFile: options.installEvidenceFile ?? path.join(reports, 'install-evidence.json'), installEvidence: options.installEvidence });
    const { manifest, manifestSha256 } = validated;
    if (options.version !== manifest.companyVersion || !/^\d+\.\d+\.\d+$/.test(options.version ?? '')) throw new IntegrationError(2, '必须指定与manifest相同的精确公司版本');
    if (manifest.magpieCompanyCommit !== ctx.provenance.magpieCompanyCommit || manifest.nikouEffectiveCommit !== ctx.provenance.nikouEffectiveCommit || manifest.lockSha256 !== ctx.provenance.lockSha256) throw new IntegrationError(15, '源码与最终包提交/锁摘要不同');
    const origin = await git(ctx.root, ['remote', 'get-url', 'origin'], ctx.run).catch(() => '');
    if (!origin || origin === ctx.lock.magpie.repository || ctx.policy.magpie.allowedRepositories.includes(origin)) throw new IntegrationError(11, '公司origin缺失或仍为上游，拒绝生成正式发布计划');
    if (options.channel && options.channel !== 'stable') throw new IntegrationError(2, '本轮仅支持stable公司通道');
    const previous = await readdir(path.join(reports, 'release-plans')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const tuple = version => version.split('.').map(Number);
    const compare = (a, b) => { const x = tuple(a), y = tuple(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
    if (previous.some(name => /^\d+\.\d+\.\d+\.md$/.test(name) && compare(name.slice(0, -3), options.version) >= 0)) throw new IntegrationError(2, '公司版本必须高于已有发布计划');
    const out = path.join(reports, 'release-plans', `${options.version}.md`); await safeDirectory(ctx.root, out); await mkdir(path.dirname(out), { recursive: true });
    const content = `# 公司版本 ${options.version} 发布计划\n\n目标通道：stable。公司来源：${origin}。本文件仅供审核，尚未发布。\n\nmanifest SHA256：${manifestSha256}\n\n组合：magpie上游 ${manifest.magpieUpstreamCommit}，公司构建 ${manifest.magpieCompanyCommit}；Nikou上游 ${manifest.nikouUpstreamCommit}，实际构建 ${manifest.nikouEffectiveCommit}。\n\nNode ${manifest.toolchain.node}，ABI ${manifest.toolchain.nodeAbi}。安装及回滚演练事务：${validated.evidence.transactionId}。\n\n许可：保留magpie MIT与Nikou公司内部授权全文。仅在公司内部发布，不自动推送或推广通道。\n`;
    await writeFile(out, content, { flag: 'wx' }); return { exitCode: 0, status: 'ready-for-review', releasePlanFile: out, manifestSha256, companyOrigin: origin };
  } catch (error) { return failure(error); }
}
