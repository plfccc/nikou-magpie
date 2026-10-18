import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { fakeBuild } from './fixtures/fake-build.mjs';

test('打包只接受精确资产验收证据并包含许可证与四种提交身份', async t => {
  const module = await import('../scripts/lib/package.mjs').catch(() => ({}));
  assert.equal(typeof module.packageRelease, 'function', '必须实现精确资产门禁打包');
  const { verify } = await import('../scripts/lib/verify.mjs'); const w = await fakeBuild(t);
  assert.equal((await module.packageRelease({ ...w.options, build: w.built, version: '1.0.0' })).exitCode, 15);
  const evidence = await verify({ ...w.options, profile: 'artifacts', build: w.built });
  const packed = await module.packageRelease({ ...w.options, build: w.built, artifactEvidence: evidence, version: '1.0.0' });
  assert.equal(packed.exitCode, 0, JSON.stringify(packed));
  assert.equal(packed.manifest.nikouEffectiveCommit, w.lock.nikou.effectiveCommit);
  assert.equal(packed.manifest.magpieCompanyCommit, w.git(w.root, 'rev-parse', 'HEAD'));
  assert.ok(packed.manifest.assets.some(a => a.role === 'license-nikou'));
  assert.equal(JSON.parse(await readFile(packed.manifestFile, 'utf8')).companyVersion, '1.0.0');
  assert.equal((await module.releasePlan({ ...w.options, manifest: packed.manifestFile, version: '1.0.0' })).exitCode, 16);
  const installEvidence = { schemaVersion: 1, profile: 'install', ok: true, manifestSha256: packed.manifestSha256, packageSha256: packed.packageSha256, transactionId: 'isolated-transaction', checks: [{ name: 'install-health', status: 'pass' }, { name: 'rollback-health', status: 'pass' }], createdAt: new Date().toISOString() };
  assert.equal((await verify({ ...w.options, profile: 'install', manifest: packed.manifestFile, installEvidence })).exitCode, 0);
  assert.equal((await module.releasePlan({ ...w.options, manifest: packed.manifestFile, version: '1.0.0', installEvidence })).exitCode, 11);
  w.git(w.root, 'remote', 'set-url', 'origin', `${w.dir}/company-remote`);
  assert.equal((await module.releasePlan({ ...w.options, manifest: packed.manifestFile, version: '1.0.0', installEvidence: { ...installEvidence, manifestSha256: '0'.repeat(64) } })).exitCode, 16);
  const plan = await module.releasePlan({ ...w.options, manifest: packed.manifestFile, version: '1.0.0', installEvidence });
  assert.equal(plan.exitCode, 0, JSON.stringify(plan)); assert.equal(plan.status, 'ready-for-review');
  assert.ok((await readFile(plan.releasePlanFile, 'utf8')).includes('尚未发布'));
});
