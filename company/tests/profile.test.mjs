import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { planProfile, applyProfile } from '../scripts/lib/profile.mjs';

async function fixture(t, config = { api: { active: 'old', profiles: { old: { model: '旧模型' } } }, hook: { engine: 'codex' } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-profile-'));
  const workerConfigPath = path.join(dir, 'worker.json');
  fs.writeFileSync(workerConfigPath, JSON.stringify(config));
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'provider/model-20261019' }, { id: 'other/full-id' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { workerConfigPath, gatewayUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'MAGPIE_KEY', env: { MAGPIE_KEY: 'fixture-secret' }, managedDir: path.join(dir, 'private'), confirmed: true, offlineConfirmed: true, privateDirectoryConfirmed: true };
}

test('真实 HTTP 导入完整模型且保留 active、旧 profile 和其他引擎', async t => {
  const options = await fixture(t);
  const plan = await planProfile(options);
  assert.equal(JSON.stringify(plan).includes('fixture-secret'), false);
  assert.deepEqual(plan.profile.models, ['other/full-id', 'provider/model-20261019']);
  assert.equal(applyProfile({ ...options, plan }).status, 'APPLIED_OFFLINE');
  const config = JSON.parse(fs.readFileSync(options.workerConfigPath));
  assert.equal(config.api.active, 'old');
  assert.deepEqual(config.api.profiles.old, { model: '旧模型' });
  assert.equal(config.hook.engine, 'codex');
  assert.equal(config.api.profiles.magpie.api_key_env, 'MAGPIE_KEY');
  assert.equal(fs.readdirSync(options.managedDir).length, 1);
});
test('拒绝已有 magpie profile', async t => {
  const options = await fixture(t, { api: { profiles: { magpie: {} } } });
  await assert.rejects(planProfile(options), /已存在/);
});
test('拒绝截断或不在网关白名单中的模型', async t => {
  const options = await fixture(t);
  await assert.rejects(planProfile({ ...options, models: ['model-20261019'] }), /白名单/);
  await assert.rejects(planProfile({ ...options, model: 'latest' }), /白名单/);
});
test('摘要变更、未确认和非本机地址拒绝写入', async t => {
  const options = await fixture(t);
  const plan = await planProfile(options);
  assert.throws(() => applyProfile({ ...options, plan, confirmed: false }), /确认/);
  fs.appendFileSync(options.workerConfigPath, ' ');
  assert.throws(() => applyProfile({ ...options, plan }), /并发/);
  await assert.rejects(planProfile({ ...options, gatewayUrl: 'https://example.com/v1' }), /回环/);
});
test('嵌套 api 保留层级且不新建 active', async t => {
  const options = await fixture(t, { ai_hook: { api: { profiles: { old: {} } } } });
  const plan = await planProfile(options);
  applyProfile({ ...options, plan });
  const config = JSON.parse(fs.readFileSync(options.workerConfigPath));
  assert.equal(config.api, undefined);
  assert.equal(config.ai_hook.api.active, undefined);
  assert.ok(config.ai_hook.api.profiles.magpie);
});
