import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { failure, IntegrationError, digest } from './lock.mjs';
import { head } from './git.mjs';
import { checkEvidence, command, fingerprint, json, npm, reportRoot, safeDirectory, sandbox, sealEvidence, sourceContext, validateAssets, writeJson } from './evidence.mjs';
import { inspectPackage } from './archive.mjs';

async function sourceVerify(options, checks) {
  const ctx = await sourceContext(options, { allowDirty: Boolean(options.allowDirty), exact: !options.allowDirty });
  const reports = reportRoot(ctx); await safeDirectory(ctx.root, reports); await mkdir(reports, { recursive: true });
  const isolated = await sandbox(reports);
  try {
    const env = isolated.env;
    // Go缓存保留在显式路径，测试HOME仍隔离于真实用户配置。
    const caches = await command(ctx, checks, 'Go缓存路径', { file: 'go', args: ['env', '-json', 'GOPATH', 'GOMODCACHE', 'GOCACHE'], cwd: ctx.root }, process.env, false);
    if (!caches.exitCode && caches.stdout.trim()) Object.assign(env, JSON.parse(caches.stdout));
    const tests = (await readdir(path.join(ctx.root, 'company/tests'))).filter(name => name.endsWith('.test.mjs')).sort();
    if (!tests.length) throw new IntegrationError(14, '维护脚本测试缺失');
    const tasks = [
      ['维护脚本全测试', { file: process.execPath, args: ['--test', ...tests.map(file => `company/tests/${file}`)], cwd: ctx.root }],
      ['Go Nikou完整模块测试', { file: 'go', args: ['test', './internal/nikou', '-count=1', '-timeout=120s'], cwd: ctx.root }],
      ['Go CLI聚焦测试', { file: 'go', args: ['test', './internal/cli', '-run', 'Nikou|Bridge|SelfCheck', '-count=1', '-timeout=120s'], cwd: ctx.root }],
      ['Go本机vet', { file: 'go', args: ['vet', './...'], cwd: ctx.root }],
      ['Go Linux nogui vet', { file: 'go', args: ['vet', '-tags', 'nogui', './...'], cwd: ctx.root, env: { GOOS: 'linux', CGO_ENABLED: '0' } }],
      ['Go Windows vet', { file: 'go', args: ['vet', './...'], cwd: ctx.root, env: { GOOS: 'windows', CGO_ENABLED: '0' } }],
      ['Go GUI内置插件及bootPrefs守卫', { file: 'go', args: ['test', './internal/gui', '-run', 'TestBuiltin|TestBootSaysBuiltinsOff|TestPluginsImportOnlyCore', '-count=1', '-timeout=120s'], cwd: ctx.root }],
      ['Go插件运行时守卫', { file: 'go', args: ['test', './internal/pluginrt', '-count=1', '-timeout=120s'], cwd: ctx.root }],
      ['公司更新隔离守卫', { file: 'go', args: ['test', './internal/update', '-run', 'TestCompany', '-count=1', '-timeout=120s'], cwd: ctx.root }],
      ['Chromium集成页面与内置守卫', { file: process.execPath, args: ['--test', 'internal/gui/tests/nikou.test.cjs', 'internal/gui/tests/builtins.test.cjs', 'internal/gui/tests/plugin-kernel.test.cjs'], cwd: ctx.root, env: { BROWSER: 'chromium' } }],
      ['WebKit集成页面与内置守卫', { file: process.execPath, args: ['--test', 'internal/gui/tests/nikou.test.cjs', 'internal/gui/tests/builtins.test.cjs', 'internal/gui/tests/plugin-kernel.test.cjs'], cwd: ctx.root, env: { BROWSER: 'webkit' } }],
      ['GUI文案键守卫', { file: process.execPath, args: ['--test', 'internal/gui/tests/i18n-keys.test.cjs'], cwd: ctx.root }],
      ['Go本机构建', { file: 'go', args: ['build', '-o', path.join(isolated.dir, 'magpie-native.exe'), '.'], cwd: ctx.root }],
      ['Go Linux nogui构建', { file: 'go', args: ['build', '-tags', 'nogui', '-o', path.join(isolated.dir, 'magpie-linux'), '.'], cwd: ctx.root, env: { GOOS: 'linux', CGO_ENABLED: '0' } }],
      ['Go Windows构建', { file: 'go', args: ['build', '-o', path.join(isolated.dir, 'magpie-windows.exe'), '.'], cwd: ctx.root, env: { GOOS: 'windows', CGO_ENABLED: '0' } }],
      ['Nikou聚焦测试', npm(ctx, ['exec', '--', 'tsx', '--test', 'test/magpie-integration.test.ts', 'test/magpie-console-server.test.ts', 'test/magpie-account-menu.test.ts', 'test/magpie-account-backend.test.ts'], ctx.nikouDir)],
      ['Nikou完整构建', npm(ctx, ['run', 'build'], ctx.nikouDir)],
      ['Go与Nikou真实契约', { file: process.execPath, args: ['company/scripts/check-contract.mjs', ctx.nikouDir], cwd: ctx.root }],
      ['Nikou隐私检查', npm(ctx, ['run', 'privacy-scan'], ctx.nikouDir)],
      ['Nikou包清单检查', npm(ctx, ['run', 'pack:check'], ctx.nikouDir)]
    ];
    const goFiles = [];
    async function collect(dir) { for (const item of await readdir(dir, { withFileTypes: true })) { if (['.git', 'artifacts', 'node_modules'].includes(item.name)) continue; const name = path.join(dir, item.name); if (item.isDirectory()) await collect(name); else if (item.name.endsWith('.go')) goFiles.push(name); } }
    await collect(ctx.root);
    for (let offset = 0; offset < goFiles.length; offset += 30) {
      const format = await command(ctx, checks, `gofmt格式检查${offset / 30 + 1}`, { file: 'gofmt', args: ['-l', ...goFiles.slice(offset, offset + 30).map(file => path.relative(ctx.root, file))], cwd: ctx.root }, env, false);
      if (format.stdout.trim()) { checks.at(-1).status = 'fail'; checks.at(-1).message = 'gofmt输出非空，源码格式不符合规范'; }
    }
    if ((options.hostPlatform ?? process.platform) === 'win32') checks.push({ name: 'Go完整nogui测试套件', status: 'not-run', reason: '上游完整套件含Unix专用测试；需在适用平台补齐，Windows只运行原生聚焦测试', requiredForPlatform: false });
    else tasks.push(['Go完整nogui测试套件', { file: 'go', args: ['test', '-tags', 'nogui', './...', '-timeout=10m'], cwd: ctx.root }]);
    for (const [label, spec] of tasks) await command(ctx, checks, label, spec, env, false);
    const current = await sourceContext(options, { allowDirty: true, exact: false });
    if (fingerprint(current.provenance) !== fingerprint(ctx.provenance)) throw new IntegrationError(10, '验证期间源码发生变化，证据无效');
    const exitCode = checks.some(c => c.status === 'fail') ? 14 : 0;
    const evidence = sealEvidence({ schemaVersion: 1, profile: 'source', createdAt: new Date().toISOString(), exitCode, releaseEligible: exitCode === 0 && !ctx.provenance.dirty && !options.allowDirty, localOnly: Boolean(options.allowDirty), provenance: ctx.provenance, toolchain: { node: process.versions.node, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch }, checks });
    const evidenceFile = path.join(reports, 'source-evidence.json'); await writeJson(evidenceFile, evidence); return { ...evidence, evidenceFile };
  } finally { await rm(isolated.dir, { recursive: true, force: true }); }
}
export async function loadBuild(ctx, options) {
  const build = options.build ?? await json(options.buildFile ?? path.join(reportRoot(ctx), 'build.json'));
  if (build.kind !== 'build' || sealEvidence(build).evidenceSha256 !== build.evidenceSha256) throw new IntegrationError(15, '构建清单摘要无效');
  await safeDirectory(ctx.root, build.buildDir);
  if (!build.buildDir.startsWith(`${reportRoot(ctx)}${path.sep}`)) throw new IntegrationError(15, '构建目录不在公司受管目录');
  if (fingerprint(build.provenance) !== fingerprint(ctx.provenance)) throw new IntegrationError(15, '当前源码HEAD、锁或工作树与构建不同');
  await validateAssets(build); return build;
}
async function artifactsVerify(options, checks) {
  const ctx = await sourceContext(options); const build = await loadBuild(ctx, options);
  const reports = reportRoot(ctx); const isolated = await sandbox(reports);
  try {
    const pkg = build.assets.find(a => a.role === 'nikou-package'); const exe = build.assets.find(a => a.role === 'magpie'); const node = build.assets.find(a => a.role === 'node-runtime');
    if (!pkg || !exe || !node) throw new IntegrationError(15, '缺少EXE、完整npm包或私有Node');
    await inspectPackage(path.join(build.buildDir, pkg.path), ctx.lock.nikou, build.consoleResources);
    checks.push({ name: '完整包与控制台资源摘要', status: 'pass' });
    if ((options.hostPlatform ?? process.platform) !== 'win32') throw new IntegrationError(14, 'Windows EXE验收要求原生Windows，不跨平台假验证');
    const requests = [
      ['magpie专用自检', { file: path.join(build.buildDir, exe.path), args: ['nikou-self-check', '--json'], cwd: build.buildDir }, 'magpie'],
      ['Nikou专用自检', { file: path.join(build.buildDir, node.path), args: [path.join(build.buildDir, build.runtime.entry), 'integration-check', '--json'], cwd: path.join(build.buildDir, build.runtime.directory) }, 'nikou']
    ];
    for (const [label, spec, component] of requests) {
      const result = await command(ctx, checks, label, spec, isolated.env);
      let output; try { output = JSON.parse(result.stdout.trim()); } catch { throw new IntegrationError(14, `${label}未返回JSON，未验证不能发布`); }
      if (output.ok !== true || output.protocol !== ctx.lock.bridgeProtocol || output.component !== component || output.version !== (component === 'nikou' ? ctx.lock.nikou.version : build.companyVersion) || (component === 'nikou' && String(output.nodeAbi) !== build.toolchain.nodeAbi)) throw new IntegrationError(13, `${label}协议、版本或ABI不匹配`);
    }
    const current = await sourceContext(options); if (fingerprint(current.provenance) !== fingerprint(ctx.provenance)) throw new IntegrationError(15, '自检期间源码变化');
    await validateAssets(build);
    const evidence = sealEvidence({ schemaVersion: 1, profile: 'artifacts', exitCode: 0, createdAt: new Date().toISOString(), releaseEligible: true, buildSha256: build.evidenceSha256, provenance: build.provenance, assetsSha256: fingerprint(build.assets), assets: build.assets, checks });
    const evidenceFile = path.join(reports, 'artifacts-evidence.json'); await writeJson(evidenceFile, evidence); return { ...evidence, evidenceFile };
  } finally { await rm(isolated.dir, { recursive: true, force: true }); }
}
export async function verify(options = {}) {
  const checks = [];
  try {
    if (options.profile === 'source') return await sourceVerify(options, checks);
    if (options.allowDirty) throw new IntegrationError(2, '--allow-dirty仅允许本地source验证');
    if (options.profile === 'artifacts') return await artifactsVerify(options, checks);
    if (options.profile === 'install') {
      const { validateInstallEvidence } = await import('./package.mjs');
      const root = path.resolve(options.root ?? process.cwd());
      const result = await validateInstallEvidence({ manifestPath: options.manifest ?? options.manifestPath, installEvidenceFile: options.installEvidenceFile ?? path.join(root, 'artifacts/company/install-evidence.json'), installEvidence: options.installEvidence });
      return { exitCode: 0, profile: 'install', releaseEligible: true, manifestSha256: result.manifestSha256, transactionId: result.evidence.transactionId, checks: result.evidence.checks };
    }
    throw new IntegrationError(2, 'verify必须明确选择source、artifacts或install');
  } catch (error) {
    const result = sealEvidence({ schemaVersion: 1, profile: options.profile, ...failure(error), releaseEligible: false, checks, createdAt: new Date().toISOString() });
    if (error.exitCode !== 10 && error.exitCode !== 11) {
      try { const root = path.resolve(options.root ?? process.cwd()); const file = path.join(root, 'artifacts/company', `${options.profile}-failure.json`); await safeDirectory(root, path.dirname(file)); await writeJson(file, result); } catch { /* 原始失败保持为首要证据。 */ }
    }
    return result;
  }
}
