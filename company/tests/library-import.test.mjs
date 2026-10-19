import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { planLibraryImport, applyLibraryImport } from '../scripts/lib/library-import.mjs';
import { main } from '../scripts/integrate.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '技能 导入-')); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { databasePath: path.join(root, 'source.db'), skillsRoot: path.join(root, 'source-skills'), magpieConfigDir: path.join(root, 'magpie'), backupDir: path.join(root, 'private-backups'), confirmed: true, privateDirectoryConfirmed: true };
  fs.mkdirSync(path.join(options.skillsRoot, 'test-skill'), { recursive: true }); fs.writeFileSync(path.join(options.skillsRoot, 'test-skill/SKILL.md'), '---\nname: test-skill\ndescription: 测试\n---\n内容');
  const script = "import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.executescript('CREATE TABLE skills(id TEXT,directory TEXT,enabled_claude INTEGER,enabled_codex INTEGER); CREATE TABLE mcp_servers(id TEXT,server_config TEXT,enabled_claude INTEGER,enabled_codex INTEGER,enabled_nikou INTEGER);');d.execute('INSERT INTO skills VALUES(?,?,?,?)',('local:test-skill','test-skill',0,1));d.execute('INSERT INTO mcp_servers VALUES(?,?,?,?,?)',('test-mcp',sys.argv[2],1,1,1));d.commit();d.close()";
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script, options.databasePath, JSON.stringify({ type: 'stdio', command: 'node', args: ['fixture.js'], env: { TOKEN: 'private-test-value' }, startup_timeout_sec: 60 })], { windowsHide: true });
  return options;
}
test('计划只读脱敏，真实SQLite备份与技能复制后脱离来源，保留开关', async t => {
  const o = fixture(t); const plan = planLibraryImport(o);
  assert.equal(fs.existsSync(o.magpieConfigDir), false); assert.doesNotMatch(JSON.stringify(plan), /private-test-value|fixture.js/);
  const result = await applyLibraryImport({ ...o, plan }); assert.equal(result.skills.added, 1); assert.equal(result.mcp.added, 1);
  assert.ok(fs.existsSync(path.join(result.backupDir, 'cc-switch.db')));
  const lib = JSON.parse(fs.readFileSync(path.join(o.magpieConfigDir, 'library.json')));
  assert.deepEqual(lib.skills[0].agents, ['codex']); assert.deepEqual(lib.mcp[0].agents, ['claude', 'codex']); assert.equal(lib.mcp[0].env.TOKEN, 'private-test-value');
  await rm(o.skillsRoot, { recursive: true }); assert.ok(fs.existsSync(path.join(o.magpieConfigDir, 'library/skills/test-skill/SKILL.md')));
});
test('重复导入幂等，不覆盖后改技能与已有配置', async t => {
  const o = fixture(t); await applyLibraryImport({ ...o, plan: planLibraryImport(o) });
  let plan = planLibraryImport(o); assert.equal(plan.skills[0].state, 'had'); assert.equal(plan.mcp[0].state, 'had');
  await applyLibraryImport({ ...o, plan });
  fs.appendFileSync(path.join(o.magpieConfigDir, 'library/skills/test-skill/SKILL.md'), '用户后改');
  plan = planLibraryImport(o); assert.equal(plan.skills[0].state, 'conflict');
  const result = await applyLibraryImport({ ...o, plan }); assert.deepEqual(result.skills.conflicts, ['test-skill']);
  assert.match(fs.readFileSync(path.join(o.magpieConfigDir, 'library/skills/test-skill/SKILL.md'), 'utf8'), /用户后改/);
});
test('损坏源配置、路径越界与未确认均拒绝', async t => {
  const o = fixture(t); const plan = planLibraryImport(o);
  await assert.rejects(applyLibraryImport({ ...o, plan, confirmed: false }), /确认/);
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', "import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute('UPDATE skills SET directory=?',('../escape',));d.commit();d.close()", o.databasePath], { windowsHide: true });
  assert.throws(() => planLibraryImport(o), /名称/);
});
test('并发配置变更不覆盖，失败回退仅清理本次新增目录', async t => {
  const o = fixture(t); const plan = planLibraryImport(o);
  fs.mkdirSync(o.magpieConfigDir); fs.writeFileSync(path.join(o.magpieConfigDir, 'library.json'), JSON.stringify({ skills: [], mcp: [], instructions: { agents: [], active: 'keep' } }));
  await assert.rejects(applyLibraryImport({ ...o, plan }), /变化/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(o.magpieConfigDir, 'library.json'))).instructions.active, 'keep');
  const changed = planLibraryImport(o); const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (a, b) => { if (b === path.join(o.magpieConfigDir, 'library.json')) throw Error('注入写入失败'); return rename(a, b); });
  await assert.rejects(applyLibraryImport({ ...o, plan: changed }), /注入/);
  assert.equal(fs.existsSync(path.join(o.magpieConfigDir, 'library/skills/test-skill')), false);
  assert.equal(fs.existsSync(path.join(o.magpieConfigDir, 'cc-switch-import.json')), false);
});

test('CLI 计划与应用使用同一脱敏计划并要求确认', async t => {
  const o = fixture(t);
  const args = ['--database-path', o.databasePath, '--skills-root', o.skillsRoot, '--magpie-config-dir', o.magpieConfigDir, '--backup-dir', o.backupDir];
  const planFile = path.join(path.dirname(o.databasePath), 'plan.json');
  const planned = await main(['library', 'plan', ...args, '--out', planFile]);
  assert.equal(planned.exitCode, 0); assert.doesNotMatch(JSON.stringify(planned), /private-test-value/);
  const rejected = await main(['library', 'apply', ...args, '--from-plan', planFile]);
  assert.notEqual(rejected.exitCode, 0);
  const applied = await main(['library', 'apply', ...args, '--from-plan', planFile, '--confirmed', '--private-directory-confirmed']);
  assert.equal(applied.exitCode, 0); assert.equal(applied.skills.added, 1);
});
