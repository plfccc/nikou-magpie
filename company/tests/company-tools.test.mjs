import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkCompanyTools } from '../scripts/check-company-tools.mjs';

test('公司工具按包元数据检测升级，失败保持未知', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'company-tools-'));
  try {
    await mkdir(path.join(root, 'hst-mcp'));
    await writeFile(path.join(root, 'hst-mcp/package.json'), JSON.stringify({ name: 'hst-mcp', version: '1.1.9' }));
    const tools = await checkCompanyTools({ globalRoot: root, fetchMetadata: async url => {
      assert.ok(!url.endsWith('/latest'));
      if (url.endsWith('nikou-node')) throw Error('离线');
      return { ok: true, json: async () => ({ 'dist-tags': { latest: '1.1.16' } }) };
    } });
    assert.equal(tools[0].state, 'update-available');
    assert.equal(tools[1].state, 'unknown');
    assert.equal(tools[1].latest, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
