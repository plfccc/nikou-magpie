import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { canonical } from './report.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(canonical(value));
const agents = { claude: 'claude', codex: 'codex', gemini: 'gemini', opencode: 'opencode', hermes: 'hermes', mcode: 'mcode', pi: 'pi' };
function protectDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); return; }
  const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' }).match(/S-1-5-[0-9-]+/)?.[0];
  if (!sid) throw Error('无法识别当前用户以保护 MCP 私密配置');
  execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
  for (const name of ['library.json', 'cc-switch-import.json']) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F'], { windowsHide: true, stdio: 'pipe' });
  }
  const script = "$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $root=$env:NIKOU_PRIVATE_DIRECTORY; $paths=@($root); foreach($name in @('library.json','cc-switch-import.json')){$file=Join-Path $root $name; if(Test-Path -LiteralPath $file){$paths+=$file}}; foreach($file in $paths){$actual=Get-Acl -LiteralPath $file; if(!$actual.AreAccessRulesProtected -or !$actual.Access.Count -or @($actual.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18') }).Count){throw 'ACL validation failed'}}";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'pipe', env: { ...process.env, NIKOU_PRIVATE_DIRECTORY: directory } });
}
function checked(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error('导入路径必须为绝对路径');
  const result = path.resolve(value);
  for (let p = result; ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error('受管导入路径不能经过链接');
    if (p === path.dirname(p)) return result;
  }
}
function raw(file) { try { return fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function object(bytes) {
  const data = JSON.parse(bytes.toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('配置必须为JSON对象');
  return data;
}
function atomic(file, bytes) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function safeName(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value); }
function tree(directory) {
  if (!fs.existsSync(directory)) return null;
  const result = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error('Skill内部链接需要单独处理，未复制不明确的链接');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        try { result.push({ path: file.split(path.sep).join('/'), sha256: sha(fs.readFileSync(path.join(directory, file))) }); }
        catch (error) {
          // Windows 文件过滤器偶尔会在目录枚举中留下已不存在的临时 .IPGSD 项；
          // 只忽略确认已经消失的条目，其他读取错误仍然中止导入。
          if (error.code !== 'ENOENT' || !entry.name.endsWith('.IPGSD') || !fs.existsSync(path.join(directory, file.slice(0, -6)))) throw error;
        }
      }
      else throw Error('Skill包含不支持的文件类型');
    }
  }
  visit(''); return digest(result);
}
async function copyTree(source, target) {
  await mkdir(target, { mode: 0o700 });
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw Error('Skill复制时发现链接，已停止');
    if (item.isDirectory()) await copyTree(path.join(source, item.name), path.join(target, item.name));
    else if (item.isFile()) await copyFile(path.join(source, item.name), path.join(target, item.name), fs.constants.COPYFILE_EXCL);
    else throw Error('Skill复制时发现不支持的文件');
  }
}
function assignments(row) { return Object.entries(agents).filter(([column]) => row[`enabled_${column}`] === 1).map(([, id]) => id).sort(); }
function server(row) {
  const config = object(Buffer.from(row.server_config));
  const transport = config.type ?? config.transport ?? (config.url ? 'http' : 'stdio');
  if (!['stdio', 'http', 'sse'].includes(transport)) throw Error('MCP传输类型不支持');
  const result = { name: row.id, transport, agents: assignments(row) };
  if (!safeName(row.id)) throw Error('MCP名称不安全');
  if (transport === 'stdio') {
    if (typeof config.command !== 'string' || !config.command.trim() || (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(a => typeof a !== 'string')))) throw Error('MCP命令或参数格式错误');
    result.command = config.command; result.args = config.args ?? []; result.env = config.env ?? {};
  } else {
    const url = new URL(config.url); if (!['http:', 'https:'].includes(url.protocol)) throw Error('MCP地址协议不支持');
    result.url = config.url; result.headers = config.headers ?? {};
  }
  for (const record of [result.env, result.headers].filter(Boolean)) if (!record || typeof record !== 'object' || Array.isArray(record) || Object.values(record).some(v => typeof v !== 'string')) throw Error('MCP环境变量或请求头格式错误');
  for (const key of ['env', 'headers']) if (result[key] && !Object.keys(result[key]).length) delete result[key];
  if (result.args?.length === 0) delete result.args;
  return { result, sourceConfig: config, extraFields: Object.keys(config).filter(k => !['type', 'transport', 'command', 'args', 'env', 'url', 'headers'].includes(k)), unsupportedAssignments: ['kiro', 'nikou', 'grokbuild'].filter(k => row[`enabled_${k}`] === 1) };
}
function inspect(options) {
  const paths = Object.fromEntries(['databasePath', 'skillsRoot', 'magpieConfigDir', 'backupDir'].map(k => [k, checked(options[k])]));
  if (new Set(Object.values(paths).map(p => p.toLowerCase())).size !== 4) throw Error('来源、目标和备份路径不能相同');
  const destination = paths.magpieConfigDir.toLowerCase(), backup = paths.backupDir.toLowerCase();
  if (destination.startsWith(backup + path.sep) || backup.startsWith(destination + path.sep)) throw Error('目标和备份目录不能互相包含');
  for (const target of [paths.magpieConfigDir, paths.backupDir]) if (target.startsWith(paths.skillsRoot + path.sep) || paths.skillsRoot.startsWith(target + path.sep)) throw Error('来源与目标目录不能互相包含');
  const query = "import sqlite3,sys,pathlib,json; db=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True); db.row_factory=sqlite3.Row; data={'skills':[dict(r) for r in db.execute('SELECT * FROM skills ORDER BY directory')],'mcp':[dict(r) for r in db.execute('SELECT * FROM mcp_servers ORDER BY id')]}; db.close(); print(json.dumps(data,ensure_ascii=False))";
  const { skills, mcp } = JSON.parse(execFileSync(options.pythonExecutable ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-c', query, paths.databasePath], { shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
  const file = path.join(paths.magpieConfigDir, 'library.json');
  const previous = raw(file);
  const library = previous ? object(previous) : { instructions: { agents: [] }, mcp: [], skills: [], applied: {} };
  if (!Array.isArray(library.mcp) || !Array.isArray(library.skills)) throw Error('目标Library结构损坏');
  const skillItems = skills.map(row => {
    if (!safeName(row.directory)) throw Error('Skill目录名称不安全');
    const source = path.join(paths.skillsRoot, row.directory); checked(source);
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw Error('Skill缺少SKILL.md');
    const hash = tree(source); const target = path.join(paths.magpieConfigDir, 'library/skills', row.directory); checked(target);
    const existing = library.skills.find(s => s.name === row.directory);
    const targetHash = tree(target);
    const state = existing || targetHash ? (existing && targetHash === hash && digest(existing.agents ?? []) === digest(assignments(row)) ? 'had' : 'conflict') : 'add';
    return { name: row.directory, source, target, sha256: hash, state, agents: assignments(row), sourceId: row.id };
  });
  const mcpItems = mcp.map(row => {
    const item = server(row); const existing = library.mcp.find(s => s.name === row.id);
    return { ...item, name: row.id, state: !existing ? 'add' : digest(existing) === digest(item.result) ? 'had' : 'conflict' };
  });
  return { paths, file, previous, library, skillItems, mcpItems, sourceSha256: digest({ skills, mcp }) };
}
function publicPlan(data) {
  const result = { schemaVersion: 1, paths: data.paths, librarySha256: data.previous ? sha(data.previous) : null, sourceSha256: data.sourceSha256,
    skills: data.skillItems.map(({ name, state, sha256, agents }) => ({ name, state, sha256, agents })),
    mcp: data.mcpItems.map(({ name, state, extraFields, unsupportedAssignments }) => ({ name, state, extraFields, unsupportedAssignments })) };
  return { ...result, planId: digest(result) };
}
export function planLibraryImport(options) { return publicPlan(inspect(options)); }

export async function applyLibraryImport(options) {
  if (options.confirmed !== true || options.privateDirectoryConfirmed !== true) throw Error('导入需要明确确认和私有备份目录');
  const data = inspect(options); const plan = publicPlan(data);
  if (options.plan?.planId !== plan.planId) throw Error('配置或来源变化，必须重新生成导入计划');
  protectDirectory(data.paths.backupDir);
  protectDirectory(data.paths.magpieConfigDir);
  const lockFile = path.join(data.paths.magpieConfigDir, '.cc-switch-import.lock');
  const fd = fs.openSync(lockFile, 'wx', 0o600);
  const transactionId = randomUUID(); const backupDir = path.join(data.paths.backupDir, transactionId); fs.mkdirSync(backupDir, { mode: 0o700 });
  const created = []; let committed = false, metadataWritten = false, priorMetadata;
  const metadataFile = path.join(data.paths.magpieConfigDir, 'cc-switch-import.json');
  try {
    const snapshot = "import sqlite3,sys,pathlib; src=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True); dst=sqlite3.connect(sys.argv[2]); src.backup(dst); dst.close(); src.close()";
    execFileSync(options.pythonExecutable ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-c', snapshot, data.paths.databasePath, path.join(backupDir, 'cc-switch.db')], { shell: false, windowsHide: true, timeout: 30_000, stdio: 'pipe' });
    if (data.previous) fs.writeFileSync(path.join(backupDir, 'library.json.backup'), data.previous, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(backupDir, 'mcp-source-private.json'), JSON.stringify(data.mcpItems.map(s => ({ id: s.name, config: s.sourceConfig, unsupportedAssignments: s.unsupportedAssignments }))), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(backupDir, 'receipt.json'), JSON.stringify({ transactionId, state: 'PREPARED', plan }), { flag: 'wx', mode: 0o600 });
    for (const item of data.skillItems.filter(s => s.state === 'add')) {
      const stage = path.join(backupDir, `stage-${item.name}`); await copyTree(item.source, stage);
      if (tree(stage) !== item.sha256) throw Error('Skill复制后摘要不一致');
      fs.mkdirSync(path.dirname(item.target), { recursive: true }); fs.renameSync(stage, item.target); created.push(item.target);
      if (tree(item.target) !== item.sha256) throw Error('Skill 写入目标后摘要不一致，请检查本机文件处理软件');
      data.library.skills.push({ name: item.name, agents: item.agents });
    }
    for (const item of data.mcpItems.filter(s => s.state === 'add')) data.library.mcp.push(item.result);
    const now = raw(data.file);
    if ((now ? sha(now) : null) !== plan.librarySha256 || inspect(options).sourceSha256 !== plan.sourceSha256) throw Error('导入期间源或目标被并发修改');
    // Library不保存的来源元数据单独保留，不能在Go下次保存后丢失。
    priorMetadata = raw(metadataFile); if (priorMetadata) fs.writeFileSync(path.join(backupDir, 'import-metadata.backup'), priorMetadata, { flag: 'wx', mode: 0o600 });
    atomic(metadataFile, JSON.stringify({ transactionId, planId: plan.planId, sourceDatabase: data.paths.databasePath, extraFields: plan.mcp.filter(s => s.extraFields.length || s.unsupportedAssignments.length) }, null, 2));
    metadataWritten = true;
    const finalBytes = raw(data.file);
    if ((finalBytes ? sha(finalBytes) : null) !== plan.librarySha256) throw Error('提交前目标配置被并发修改');
    atomic(data.file, JSON.stringify(data.library, null, 2) + '\n'); committed = true;
    const result = { ok: true, transactionId, backupDir, skills: { added: plan.skills.filter(s => s.state === 'add').length, had: plan.skills.filter(s => s.state === 'had').length, conflicts: plan.skills.filter(s => s.state === 'conflict').map(s => s.name) }, mcp: { added: plan.mcp.filter(s => s.state === 'add').length, had: plan.mcp.filter(s => s.state === 'had').length, conflicts: plan.mcp.filter(s => s.state === 'conflict').map(s => s.name) }, compatibility: plan.mcp.filter(s => s.extraFields.length || s.unsupportedAssignments.length) };
    try { atomic(path.join(backupDir, 'receipt.json'), JSON.stringify({ ...result, state: 'COMMITTED' }, null, 2)); }
    catch { return { ...result, state: 'COMMITTED_RECEIPT_FAILED', warning: '库已提交，但回执写入失败，请保留备份目录并核对目标库，不要按未提交处理' }; }
    return result;
  } finally {
    if (!committed) for (const directory of created) await rm(directory, { recursive: true, force: true });
    if (!committed && metadataWritten) { if (priorMetadata) atomic(metadataFile, priorMetadata); else if (fs.existsSync(metadataFile)) fs.unlinkSync(metadataFile); }
    fs.closeSync(fd); fs.unlinkSync(lockFile);
  }
}
