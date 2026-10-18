import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRelease, rollbackRelease, resolveInstalled } from './lib/install.mjs';
import { digest } from './lib/lock.mjs';
import { writeJson } from './lib/evidence.mjs';

export async function exerciseInstall({ manifestPath, evidencePath }) {
  if (!manifestPath || !evidencePath || !path.isAbsolute(manifestPath) || !path.isAbsolute(evidencePath)) throw Error('必须指定绝对manifest与证据输出路径');
  const bytes = await readFile(manifestPath); const manifest = JSON.parse(bytes);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nikou-install-exercise-'));
  try {
    const options = { manifestPath, installRoot: path.join(temporary, 'managed'), offline: true };
    const first = await installRelease(options);
    if (!first.ok) throw Error('隔离首次安装失败，未生成通过证据');
    const second = await installRelease(options);
    if (!second.ok) throw Error('隔离更新安装失败，未生成通过证据');
    const rollback = await rollbackRelease({ ...options, transactionId: second.transactionId });
    if (!rollback.ok || (await resolveInstalled(options.installRoot)).pointer.transactionId !== first.transactionId) throw Error('隔离回滚失败，未生成通过证据');
    if (digest(await readFile(manifestPath)) !== digest(bytes)) throw Error('演练期间manifest发生变化');
    const evidence = { schemaVersion: 1, profile: 'install', ok: true, manifestSha256: digest(bytes), packageSha256: manifest.packageSha256,
      transactionId: second.transactionId, createdAt: new Date().toISOString(),
      checks: [{ name: 'install-首次安装真实双组件自检', status: 'pass' }, { name: 'install-更新后真实双组件自检', status: 'pass' }, { name: 'rollback-旧组合真实自检与指针恢复', status: 'pass' }] };
    await mkdir(path.dirname(evidencePath), { recursive: true }); await writeJson(evidencePath, evidence);
    return evidence;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await exerciseInstall({ manifestPath: process.argv[2], evidencePath: process.argv[3] }); process.stdout.write(`${JSON.stringify(result)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
