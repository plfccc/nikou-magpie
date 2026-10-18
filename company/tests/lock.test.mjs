import test from 'node:test';
import assert from 'node:assert/strict';

test('锁校验拒绝非完整提交和未经验证的源码模式', async () => {
  const module = await import('../scripts/lib/lock.mjs').catch(() => ({}));
  assert.equal(typeof module.validateLock, 'function', '必须实现锁校验函数');
  const lock = { schemaVersion: 1, bridgeProtocol: 1, magpie: { repository: 'https://example.invalid/m.git', commit: 'a'.repeat(40) }, nikou: { mode: 'artifact', package: 'nikou-cli', version: '1.0.0', integrity: 'sha512-YWJj', sourceVerified: false } };
  assert.equal(module.validateLock(lock).ok, true);
  for (const commit of ['abc123', 'latest']) assert.equal(module.validateLock({ ...lock, magpie: { ...lock.magpie, commit } }).exitCode, 2);
  assert.equal(module.validateLock(lock, { mode: 'source' }).exitCode, 11);
  assert.equal(module.validateLock({ ...lock, nikou: { ...lock.nikou, integrity: '' } }).ok, false);
});
