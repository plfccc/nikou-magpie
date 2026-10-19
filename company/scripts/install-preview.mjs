import { readFile, writeFile, mkdir, readdir, lstat, copyFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { runProcess } from './lib/process.mjs';
import { safeDirectory, sandbox } from './lib/evidence.mjs';

const markerName = '.nikou-magpie-preview.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export async function protectPreviewDirectory(root, run = runProcess) {
  const script = "$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:NIKOU_PREVIEW_ACL_ROOT; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); $valid=@($rules | Where-Object { !$_.IsInherited -and $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -in @($user,'S-1-5-18') -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and ($_.InheritanceFlags -band 3) -eq 3 }); [bool]($acl.AreAccessRulesProtected -and $rules.Count -eq 2 -and $valid.Count -eq 2 -and @($valid | Select-Object -ExpandProperty IdentityReference -Unique).Count -eq 2)";
  const check = () => run({ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env: { ...process.env, NIKOU_PREVIEW_ACL_ROOT: root }, timeoutMs: 30_000 });
  const current = await check();
  // 重复设置带继承的 ACL 会遍历已有版本的依赖树；安全权限已满足时保持原样。
  if (current.exitCode === 0 && current.stdout.trim() === 'True') return;
  const identity = await run({ file: 'whoami.exe', args: ['/user', '/fo', 'csv', '/nh'] });
  const sid = identity.stdout.match(/S-1-5-[0-9-]+/)?.[0];
  if (!sid) throw Error('无法确定当前用户 SID');
  const acl = await run({ file: 'icacls.exe', args: [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], timeoutMs: 120_000 });
  const verified = await check();
  if (acl.exitCode !== 0 || verified.exitCode !== 0 || verified.stdout.trim() !== 'True') throw Error('无法保护预览安装目录 ACL');
}
async function inventory(root) {
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw Error('预览 dist 不能包含链接');
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + '/');
      else if (entry.isFile()) files.push({ path: relative, sha256: sha256(await readFile(path.join(directory, entry.name))) });
    }
  }
  await visit(root); return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
export async function validatePreview(infoFile) {
  const info = await json(infoFile);
  if (info.developmentOnly !== true || info.releaseEligible !== false || info.protocol !== 1 || !Array.isArray(info.assets) || info.assets.length !== 2) throw Error('输入不是有效的开发预览清单');
  for (const asset of info.assets) {
    if (!/^[a-zA-Z0-9.-]+$/.test(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size)) throw Error('预览资产路径或摘要无效');
    const file = path.join(path.dirname(infoFile), asset.name);
    if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) throw Error('预览资产必须是常规文件');
    const bytes = await readFile(file);
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) throw Error(`预览资产校验失败：${asset.name}`);
  }
  if (!info.assets.some(a => a.name.endsWith('.exe')) || !info.assets.some(a => a.name.endsWith('.tgz'))) throw Error('预览资产缺少 EXE 或 Nikou 包');
  return info;
}
export function launcher(component) {
  return `# 开发预览手动入口；不会自动启动 Worker。\r\n$ErrorActionPreference = 'Stop'\r\n` +
    `$pointer = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'current.json') | ConvertFrom-Json\r\n` +
    `if ($pointer.directory -notmatch '^releases/[a-f0-9-]+$') { throw '预览版本指针无效' }\r\n` +
    `$release = Join-Path $PSScriptRoot $pointer.directory\r\n` +
    `$env:NIKOU_MANAGED_RUNTIME = '1'\r\n$env:NIKOU_ACCOUNT_BACKEND = 'magpie'\r\n$env:NIKOU_WORKER_SUPERVISOR = 'console'\r\n$env:NIKOU_CONSOLE_AUTO_START = '0'\r\n$env:NIKOU_PREVIEW_NO_LIBRARY_SYNC = '1'\r\n` +
    `$env:NIKOU_MAGPIE_BIN = Join-Path $release 'nikou-magpie.exe'\r\nRemove-Item Env:NIKOU_WORKER_RESTART_REQUEST_PATH -ErrorAction SilentlyContinue\r\n` +
    (component === 'magpie' ? `Start-Process -FilePath $env:NIKOU_MAGPIE_BIN -WorkingDirectory $release -WindowStyle Hidden\r\n` :
      `$port = 19736\r\nif (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw '控制台端口 19736 已被占用，请继续使用已有控制台' }\r\n` +
      `$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'nikou-worker-control', [System.IO.Pipes.PipeDirection]::InOut)\r\n$workerPresent = $false\r\ntry { $pipe.Connect(200); $workerPresent = $true } catch [System.TimeoutException] {} finally { $pipe.Dispose() }\r\nif ($workerPresent) { throw '已有 Worker 正在运行，请先完成受控交接后再启动预览控制台' }\r\n` +
      `& (Join-Path $release 'runtime/node.exe') (Join-Path $release 'runtime/dist/index.js') hook console --port $port\r\nexit $LASTEXITCODE\r\n`);
}
export async function createDesktopShortcut(root, run = runProcess) {
  const script = path.join(root, 'create-shortcut.ps1');
  await safeDirectory(root, script);
  await writeFile(script, '\uFEFF' + `$ErrorActionPreference = 'Stop'\r\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\r\n$desktop = [Environment]::GetFolderPath('Desktop')\r\nif (-not $desktop) { throw '无法确定桌面路径' }\r\n$shell = New-Object -ComObject WScript.Shell\r\n$shortcutPath = Join-Path $desktop 'Nikou Magpie 开发预览.lnk'\r\nif (Test-Path -LiteralPath $shortcutPath) { throw '同名桌面快捷方式已存在，请人工确认后再创建' }\r\n$shortcut = $shell.CreateShortcut($shortcutPath)\r\n$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'\r\n$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'launch-magpie.ps1') + '"'\r\n$shortcut.WorkingDirectory = $PSScriptRoot\r\n$shortcut.Description = 'Nikou 集成网关开发预览（未通过正式发布验收）'\r\n$shortcut.Save()\r\nWrite-Output $shortcutPath\r\n`, 'utf8');
  const result = await run({ file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] });
  return result.exitCode === 0 ? { ok: true, path: result.stdout.trim() } : { ok: false, message: '开发预览已安装；桌面快捷方式未创建，请使用安装目录中的 launch-magpie.ps1' };
}
export async function installPreview(options = {}) {
  const run = options.run ?? runProcess;
  const infoFile = path.resolve(options.infoFile);
  const info = await validatePreview(infoFile);
  const root = path.resolve(options.installRoot);
  if (!path.isAbsolute(options.installRoot) || path.parse(root).root === root) throw Error('必须使用专用绝对安装目录');
  await safeDirectory(path.parse(root).root, root);
  await mkdir(root, { recursive: true });
  const marker = path.join(root, markerName);
  await safeDirectory(root, marker);
  let metadata;
  try { metadata = await json(marker); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!metadata) {
    if ((await readdir(root)).length) throw Error('安装目录非空且不受预览安装器管理');
    await writeFile(marker, JSON.stringify({ product: 'nikou-magpie-preview', developmentOnly: true, releaseEligible: false }), { flag: 'wx' });
  } else if (metadata.product !== 'nikou-magpie-preview' || metadata.developmentOnly !== true || metadata.releaseEligible !== false) throw Error('预览安装目录标记无效');
  const lockFile = path.join(root, '.install.lock');
  await safeDirectory(root, lockFile);
  const lock = await open(lockFile, 'wx');
  const id = randomUUID();
  const stage = path.join(root, `stage-${id}`);
  const release = path.join(root, 'releases', id);
  let activated = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    if (process.platform === 'win32' && !options.skipAcl) {
      await protectPreviewDirectory(root, run);
    }
    await safeDirectory(root, release);
    await mkdir(path.join(root, 'releases'), { recursive: true });
    await mkdir(stage);
    const runtime = path.join(stage, 'runtime'); await mkdir(runtime);
    const exe = info.assets.find(a => a.name.endsWith('.exe'));
    const tgz = info.assets.find(a => a.name.endsWith('.tgz'));
    await copyFile(path.join(path.dirname(infoFile), exe.name), path.join(stage, 'nikou-magpie.exe'));
    const node = options.nodeExecutable ?? process.execPath;
    if (process.versions.node !== info.nodeVersion || String(process.versions.modules) !== String(info.nodeAbi)) throw Error('安装器 Node 版本或 ABI 与预览包不符');
    await copyFile(node, path.join(runtime, 'node.exe'));
    const nikouDir = path.resolve(options.nikouDir);
    const tar = createRequire(path.join(nikouDir, 'package.json'))('tar');
    const extraction = path.join(stage, 'unpack'); await mkdir(extraction);
    const stagedArchive = path.join(stage, 'nikou-input.tgz');
    await copyFile(path.join(path.dirname(infoFile), tgz.name), stagedArchive);
    if (sha256(await readFile(stagedArchive)) !== tgz.sha256) throw Error('暂存 Nikou 包摘要不符');
    await tar.x({ file: stagedArchive, cwd: extraction, strict: true, preservePaths: false,
      filter: (name, entry) => {
        if (!name.startsWith('package/') || name.split('/').includes('..') || name.includes('\\') || !['File', 'Directory'].includes(entry.type)) throw Error('Nikou 包包含不安全路径或链接');
        return true;
      } });
    const pkg = await json(path.join(extraction, 'package/package.json'));
    const distInventory = await inventory(path.join(extraction, 'package/dist'));
    const sourcePkg = await json(path.join(nikouDir, 'package.json'));
    if (pkg.name !== 'nikou-cli' || JSON.stringify(pkg) !== JSON.stringify(sourcePkg)) throw Error('Nikou 安装包与依赖锁来源不匹配');
    const lockBytes = await readFile(path.join(nikouDir, 'package-lock.json'));
    const upstreamLock = await json(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../upstreams.lock.json'));
    if (sha256(lockBytes) !== upstreamLock.nikou.dependencyLock.sha256 || upstreamLock.nikou.effectiveCommit !== info.nikouEffectiveCommit) throw Error('Nikou 依赖锁或源码身份不匹配');
    await copyFile(path.join(extraction, 'package/package.json'), path.join(runtime, 'package.json'));
    await writeFile(path.join(runtime, 'package-lock.json'), lockBytes);
    await rename(path.join(extraction, 'package/dist'), path.join(runtime, 'dist'));
    await rm(extraction, { recursive: true });
    await rm(stagedArchive);
    const npmCli = options.npmCli ?? path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js');
    const npm = await run({ file: path.join(runtime, 'node.exe'), args: [npmCli, 'ci', '--omit=dev', '--include=optional', '--no-audit', '--no-fund'], cwd: runtime, timeoutMs: 600_000 });
    if (npm.exitCode !== 0) throw Error(`预览 runtime 依赖安装失败（${npm.exitCode}）：${npm.stderr.slice(-1500)}`);
    await rename(stage, release);
    const installedRuntime = path.join(release, 'runtime');
    if (JSON.stringify(await inventory(path.join(installedRuntime, 'dist'))) !== JSON.stringify(distInventory)) throw Error('安装后 dist 文件名或摘要发生变化');
    if (sha256(await readFile(path.join(release, 'nikou-magpie.exe'))) !== exe.sha256) throw Error('安装后 EXE 摘要发生变化');
    const isolated = await sandbox(release);
    const checks = [];
    try {
      const env = { ...isolated.env, NIKOU_MANAGED_RUNTIME: '1', NIKOU_ACCOUNT_BACKEND: 'magpie', NIKOU_CONSOLE_AUTO_START: '0' };
      for (const [component, file, args] of [['magpie', path.join(release, 'nikou-magpie.exe'), ['nikou-self-check', '--json']], ['nikou', path.join(installedRuntime, 'node.exe'), [path.join(installedRuntime, 'dist/index.js'), 'integration-check', '--json']]]) {
        const result = await run({ file, args, cwd: installedRuntime, env, timeoutMs: 30_000 });
        let reply; try { reply = JSON.parse(result.stdout.trim()); } catch { throw Error(`${component} 自检未返回有效 JSON`); }
        if (result.exitCode !== 0 || !reply.ok || reply.protocol !== 1 || reply.component !== component || reply.version !== (component === 'magpie' ? info.companyVersion : pkg.version) || (component === 'nikou' && String(reply.nodeAbi) !== String(info.nodeAbi))) throw Error(`${component} 自检失败`);
        checks.push({ component, exitCode: result.exitCode, reply, isolatedUserDirectories: true });
      }
    } finally { await rm(isolated.dir, { recursive: true, force: true }); }
    const receipt = { schemaVersion: 1, developmentOnly: true, releaseEligible: false, transactionId: id, installedAt: new Date().toISOString(), directory: `releases/${id}`, companyVersion: info.companyVersion, nikouVersion: pkg.version, sourceAssets: info.assets, nodeSha256: sha256(await readFile(path.join(installedRuntime, 'node.exe'))), dependencyLockSha256: sha256(lockBytes), magpieCompanyCommit: info.magpieCompanyCommit, nikouEffectiveCommit: info.nikouEffectiveCommit, distFileCount: distInventory.length, distInventorySha256: sha256(JSON.stringify(distInventory)), checks, workerStarted: false, desktopStarted: false, consoleStarted: false };
    receipt.developmentSourceDirty = info.developmentSourceDirty === true;
    receipt.localSourceChanges = info.localSourceChanges ?? [];
    receipt.startupLibrarySyncSuppressed = true;
    await atomic(path.join(release, 'preview-install-receipt.json'), receipt);
    // 入口脚本不嵌入版本路径；只有指针原子变更后，新版本才可见。
    for (const component of ['magpie', 'console']) {
      const script = path.join(root, `launch-${component}.ps1`); await safeDirectory(root, script);
      await writeFile(script, '\uFEFF' + launcher(component), 'utf8');
    }
    await safeDirectory(root, path.join(root, 'current.json'));
    await atomic(path.join(root, 'current.json'), { directory: receipt.directory, transactionId: id, developmentOnly: true, releaseEligible: false });
    activated = true;
    return { ok: true, installRoot: root, releaseDirectory: release, receipt };
  } finally {
    if (!activated) { await rm(stage, { recursive: true, force: true }); await rm(release, { recursive: true, force: true }); }
    await lock.close(); await rm(lockFile);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, args) => value.startsWith('--') ? [...pairs, [value.slice(2), args[i + 1]]] : pairs, []));
  try {
    const result = await installPreview({ infoFile: flags.info ?? 'artifacts/company/preview/preview-info.json', nikouDir: flags['nikou-dir'] ?? '../nikou-cli-integration', installRoot: flags['install-root'] ?? path.join(process.env.LOCALAPPDATA, 'NikouMagpie/preview') });
    if (process.platform === 'win32') result.desktopShortcut = await createDesktopShortcut(result.installRoot);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`开发预览安装失败：${error.message}`); process.exitCode = 1; }
}
