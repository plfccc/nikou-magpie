import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planMigration, applyMigration, restoreMigration } from '../scripts/lib/migration.mjs';

for (const action of ['apply', 'restore']) for (const fault of ['write', 'rename']) {
  test(`${action} 最终回执 ${fault} 中断保留完整回执且可恢复`, t => {
    const { options } = fixture(t);
    if (action === 'restore') applyMigration(options);
    const receiptFile = path.join(options.managedDir, options.requestId, 'receipt.json');
    const originalWrite = fs.writeFileSync;
    const originalRename = fs.renameSync;
    let injected = false;
    fs.writeFileSync = function(file, value, ...args) {
      const status = typeof value === 'string' && value.startsWith('{') ? JSON.parse(value).result?.status : undefined;
      if (fault === 'write' && status === (action === 'apply' ? 'APPLIED_OFFLINE' : 'RESTORED')) {
        injected = true;
        originalWrite.call(this, file, '', ...args);
        throw new Error('注入回执写入中断');
      }
      return originalWrite.call(this, file, value, ...args);
    };
    fs.renameSync = function(source, target) {
      if (target === receiptFile) { injected = true; throw new Error('注入回执写入中断'); }
      return originalRename.call(this, source, target);
    };
    try { assert.throws(() => action === 'apply' ? applyMigration(options) : restoreMigration(options), /注入回执写入中断/); }
    finally { fs.writeFileSync = originalWrite; fs.renameSync = originalRename; }
    assert.equal(injected, true);
    assert.equal(JSON.parse(fs.readFileSync(receiptFile)).result.status, action === 'apply' ? 'PREPARED' : 'APPLIED_OFFLINE');
    assert.deepEqual(fs.readdirSync(path.dirname(receiptFile)).filter(name => name.endsWith('.tmp')), []);
    assert.equal(restoreMigration(options).status, 'RESTORED');
    assert.equal(fs.existsSync(options.masterCredentialsPath), false);
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '迁移 测试-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { settingsPath: path.join(root, 'settings.json'), workerConfigPath: path.join(root, 'worker.json'), runtimeScopesPath: path.join(root, 'scopes.json'), masterCredentialsPath: path.join(root, 'console', 'master-admin.json'), managedDir: path.join(root, 'private'), requestId: 'request-1', privateDirectoryConfirmed: true, offlineConfirmed: true, oldProcessIds: [2147483647] };
  fs.writeFileSync(options.settingsPath, JSON.stringify({ nikouMasterBaseUrl: 'https://example.invalid', nikouMasterAdminKey: 'sensitive-key-that-must-never-leak', nikouWorkerAutostart: false }));
  fs.writeFileSync(options.workerConfigPath, JSON.stringify({ api: { profiles: { existing: { apiKey: 'worker-secret' } } } }));
  const plan = planMigration(options);
  options.migrationId = plan.migrationId;
  return { options, plan };
}
test('计划只读且脱敏，离线应用保留 Worker/profile，重复请求不覆盖人工修改', t => {
  const { options, plan } = fixture(t);
  assert.ok(!JSON.stringify(plan).includes('sensitive-key'));
  assert.equal(fs.existsSync(options.managedDir), false);
  const original = fs.readFileSync(options.workerConfigPath);
  assert.equal(applyMigration(options).status, 'APPLIED_OFFLINE');
  assert.deepEqual(fs.readFileSync(options.workerConfigPath), original);
  assert.equal(JSON.parse(fs.readFileSync(options.masterCredentialsPath)).key, 'sensitive-key-that-must-never-leak');
  fs.writeFileSync(options.masterCredentialsPath, '{"manual":true}');
  assert.equal(applyMigration(options).status, 'APPLIED_OFFLINE');
  assert.throws(() => restoreMigration(options), /恢复冲突/);
  assert.equal(fs.readFileSync(options.masterCredentialsPath, 'utf8'), '{"manual":true}');
});
test('恢复仅删除本次新增文件，保留后续 Worker 配置和原始账号', t => {
  const { options } = fixture(t);
  applyMigration(options);
  fs.writeFileSync(options.workerConfigPath, '{"profiles":{"manual":true}}');
  assert.equal(restoreMigration(options).status, 'RESTORED');
  assert.equal(fs.existsSync(options.masterCredentialsPath), false);
  assert.equal(restoreMigration(options).status, 'RESTORED');
  assert.equal(fs.readFileSync(options.workerConfigPath, 'utf8'), '{"profiles":{"manual":true}}');
});
test('损坏配置和计划过期均拒绝且不写备份', t => {
  const { options } = fixture(t);
  fs.writeFileSync(options.workerConfigPath, '{');
  assert.throws(() => applyMigration(options), /配置损坏/);
  fs.writeFileSync(options.workerConfigPath, '{}');
  assert.throws(() => applyMigration(options), /计划已变化/);
  assert.equal(fs.existsSync(options.managedDir), false);
});
test('旧自动拉起或存活进程阻止交接', t => {
  const { options } = fixture(t);
  options.oldProcessIds = [process.pid];
  assert.throws(() => applyMigration(options), /仍在运行/);
  const settings = JSON.parse(fs.readFileSync(options.settingsPath));
  settings.nikouWorkerAutostart = true;
  fs.writeFileSync(options.settingsPath, JSON.stringify(settings));
  options.migrationId = planMigration(options).migrationId;
  assert.throws(() => applyMigration(options), /关闭 CC Switch/);
});
test('已有不同控制台凭据不被覆盖，路径必须显式且隔离', t => {
  const { options } = fixture(t);
  fs.mkdirSync(path.dirname(options.masterCredentialsPath));
  fs.writeFileSync(options.masterCredentialsPath, '{"url":"other","key":"other"}');
  assert.throws(() => planMigration(options), /已有不同/);
  assert.throws(() => planMigration({ ...options, settingsPath: 'settings.json' }), /绝对路径/);
});
