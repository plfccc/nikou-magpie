import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { failure, IntegrationError } from './lock.mjs';
import { checkEvidence, command, asset, filesUnder, fingerprint, json, npm, reportRoot, safeDirectory, sandbox, sealEvidence, snapshot, sourceContext, writeJson } from './evidence.mjs';

export async function build(options = {}) {
  const commands = []; let buildDir; let isolated;
  try {
    const ctx = await sourceContext(options);
    const platform = options.platform ?? 'windows', arch = options.arch ?? 'amd64';
    const companyVersion = options.version ?? '1.0.0';
    if (platform !== 'windows' || arch !== 'amd64' || (options.hostPlatform ?? process.platform) !== 'win32') throw new IntegrationError(2, '本轮仅支持原生Windows amd64构建');
    if (!/^\d+\.\d+\.\d+$/.test(companyVersion)) throw new IntegrationError(2, '公司版本必须为x.y.z');
    const reports = reportRoot(ctx); await safeDirectory(ctx.root, reports);
    const buildId = `${ctx.provenance.magpieCompanyCommit.slice(0, 12)}-${randomUUID()}`;
    buildDir = path.join(reports, 'builds', buildId); await safeDirectory(ctx.root, buildDir); await mkdir(buildDir, { recursive: true });
    isolated = await sandbox(buildDir); const env = { ...isolated.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' };
    const nodeResult = await command(ctx, commands, 'Node版本', { file: process.execPath, args: ['--version'], cwd: ctx.root }, env);
    const goResult = await command(ctx, commands, 'Go版本', { file: 'go', args: ['version'], cwd: ctx.root }, env);
    const npmResult = await command(ctx, commands, 'npm版本', npm(ctx, ['--version'], ctx.root), env);
    if (nodeResult.stdout.trim().replace(/^v/, '') !== ctx.policy.tools.node || process.versions.modules !== String(ctx.policy.tools.nodeAbi) || !goResult.stdout.includes(`go${ctx.policy.tools.go} `)) throw new IntegrationError(10, '实际Node、ABI或Go版本与policy不匹配');
    const goCaches = await command(ctx, commands, 'Go固定缓存', { file: 'go', args: ['env', '-json', 'GOPATH', 'GOMODCACHE', 'GOCACHE'], cwd: ctx.root }, process.env);
    if (goCaches.stdout.trim()) Object.assign(env, JSON.parse(goCaches.stdout));
    const sourceEvidence = options.sourceEvidence ?? await json(options.sourceEvidenceFile ?? path.join(reports, 'source-evidence.json')).catch(() => null);
    checkEvidence(sourceEvidence, 'source');
    if (fingerprint(sourceEvidence.provenance) !== fingerprint(ctx.provenance)) throw new IntegrationError(15, '源码验收证据与当前HEAD/锁不符');
    const magpieSource = path.join(isolated.dir, 'magpie'); const nikouSource = path.join(isolated.dir, 'nikou');
    await snapshot(ctx, ctx.root, magpieSource); await snapshot(ctx, ctx.nikouDir, nikouSource);
    const assetsDir = path.join(buildDir, 'assets'); await mkdir(assetsDir);
    const exe = path.join(assetsDir, 'magpie-windows-amd64.exe');
    await command(ctx, commands, '固定Windows资源生成器', { file: 'go', args: ['run', 'github.com/tc-hib/go-winres@v0.3.3', 'make', '--in', 'build/windows/winres.json', '--arch', 'amd64', '--out', 'rsrc', '--file-version', companyVersion, '--product-version', companyVersion], cwd: magpieSource }, env);
    await command(ctx, commands, 'Windows production EXE', { file: 'go', args: ['build', '-buildvcs=false', '-tags', 'production', '-trimpath', `-ldflags=-s -w -X main.version=${companyVersion} -X github.com/yetone/magpie/internal/update.CompanyMode=1 -H windowsgui`, '-o', exe, '.'], cwd: magpieSource }, env);
    const nativeEnv = { ...isolated.env, npm_config_audit: 'false', npm_config_fund: 'false' };
    for (const [label, args] of [['Nikou精确依赖安装', ['ci', '--include=optional']], ['Nikou构建', ['run', 'build']], ['Nikou完整测试', ['test']], ['Nikou隐私扫描', ['run', 'privacy-scan']], ['Nikou包清单', ['run', 'pack:check']]]) await command(ctx, commands, label, npm(ctx, args, nikouSource), nativeEnv);
    const packed = await command(ctx, commands, 'Nikou完整npm包', npm(ctx, ['pack', '--json', '--ignore-scripts', '--pack-destination', assetsDir], nikouSource), nativeEnv);
    let filename; try { filename = JSON.parse(packed.stdout)[0].filename; } catch { throw new IntegrationError(15, 'npm pack没有输出包清单'); }
    if (!filename || path.basename(filename) !== filename || !filename.endsWith('.tgz')) throw new IntegrationError(15, 'npm pack文件名无效');
    const runtimeDir = path.join(assetsDir, 'runtime'); await mkdir(runtimeDir);
    await cp(process.execPath, path.join(runtimeDir, 'node.exe'));
    for (const name of ['package.json', 'package-lock.json', 'LICENSE']) await cp(path.join(nikouSource, name), path.join(runtimeDir, name));
    await cp(path.join(nikouSource, 'dist'), path.join(runtimeDir, 'dist'), { recursive: true, errorOnExist: true, force: false });
    await command(ctx, commands, '私有运行时精确原生依赖', npm(ctx, ['ci', '--omit=dev', '--include=optional'], runtimeDir), nativeEnv);
    // npm会生成供开发脚本使用的.bin链接；运行时只按绝对入口启动，避免把链接带入可发布资产。
    await rm(path.join(runtimeDir, 'node_modules', '.bin'), { recursive: true, force: true });
    const licensesDir = path.join(assetsDir, 'licenses'); await mkdir(licensesDir);
    await cp(path.join(ctx.root, 'LICENSE'), path.join(licensesDir, 'magpie-LICENSE.txt')); await cp(path.join(ctx.nikouDir, 'LICENSE'), path.join(licensesDir, 'nikou-LICENSE.txt'));
    const assets = [];
    for (const relative of await filesUnder(assetsDir)) {
      const role = relative === 'magpie-windows-amd64.exe' ? 'magpie' : relative === filename ? 'nikou-package' : relative === 'runtime/node.exe' ? 'node-runtime' : relative === 'licenses/magpie-LICENSE.txt' ? 'license-magpie' : relative === 'licenses/nikou-LICENSE.txt' ? 'license-nikou' : 'nikou-runtime';
      assets.push(await asset(path.join(assetsDir, relative), buildDir, role));
    }
    const consoleResources = [];
    for (const relative of await filesUnder(path.join(nikouSource, 'dist/console/assets'))) {
      const item = await asset(path.join(nikouSource, 'dist/console/assets', relative), nikouSource, 'console'); consoleResources.push({ path: item.path, sha256: item.sha256 });
    }
    const current = await sourceContext(options); if (fingerprint(current.provenance) !== fingerprint(ctx.provenance)) throw new IntegrationError(10, '构建期间源码变化');
    const buildFile = path.join(buildDir, 'build.json');
    const built = sealEvidence({ schemaVersion: 1, kind: 'build', exitCode: 0, buildId, buildDir, buildFile, companyVersion, platform, arch, createdAt: new Date().toISOString(), provenance: ctx.provenance, sourceEvidenceSha256: sourceEvidence.evidenceSha256, toolchain: { node: ctx.policy.tools.node, nodeAbi: process.versions.modules, go: ctx.policy.tools.go, npm: npmResult.stdout.trim() }, runtime: { directory: 'assets/runtime', entry: 'assets/runtime/dist/index.js', node: 'assets/runtime/node.exe' }, assets, consoleResources, commands });
    await writeJson(buildFile, built); await writeJson(path.join(reports, 'build.json'), built); return built;
  } catch (error) {
    const result = { ...failure(error), buildDir, commands };
    if (buildDir) await writeJson(path.join(buildDir, 'build-failure.json'), result); return result;
  } finally { if (isolated) await rm(isolated.dir, { recursive: true, force: true }); }
}
