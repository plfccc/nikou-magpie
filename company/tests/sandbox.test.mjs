import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sandbox } from '../scripts/lib/evidence.mjs';

test('隔离覆盖自定义配置根并不继承 API 密钥', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maintenance-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'OPENAI_API_KEY', 'GH_TOKEN', 'QODER_CONFIG_DIR', 'OPENCODE_DB', 'XDG_STATE_HOME'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  });
  for (const key of keys) process.env[key] = 'real-user-config';
  const isolated = await sandbox(root);
  assert.ok(isolated.env.CODEX_HOME.startsWith(isolated.dir));
  assert.ok(isolated.env.CLAUDE_CONFIG_DIR.startsWith(isolated.dir));
  assert.ok(isolated.env.XDG_CONFIG_HOME.startsWith(isolated.dir));
  assert.equal(isolated.env.OPENAI_API_KEY, undefined);
  assert.equal(isolated.env.GH_TOKEN, undefined);
  assert.equal(isolated.env.QODER_CONFIG_DIR, undefined);
  assert.equal(isolated.env.OPENCODE_DB, undefined);
  assert.ok(isolated.env.XDG_STATE_HOME.startsWith(isolated.dir));
});
