import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { workspace } from './git/workspace.mjs';

export async function fakeBuild(t) {
  const { build } = await import('../../scripts/lib/build.mjs');
  const { verify } = await import('../../scripts/lib/verify.mjs');
  const { makeTar } = await import('./build-assets.mjs');
  const w = await workspace(t);
  await writeFile(`${w.root}/.gitignore`, '/artifacts/\n'); await writeFile(`${w.root}/LICENSE`, 'MIT');
  w.git(w.root, 'add', '.'); w.git(w.root, 'commit', '-m', '构建基线');
  await writeFile(`${w.nikouDir}/LICENSE`, '公司内部授权'); w.git(w.nikouDir, 'add', '.'); w.git(w.nikouDir, 'commit', '-m', '公司源码');
  w.lock.nikou.effectiveCommit = w.git(w.nikouDir, 'rev-parse', 'HEAD');
  w.policy.tools.go = '1.26.8'; w.policy.tools.bun = '1.4.2';
  const commands = [];
  const run = async o => {
    if (o.file === 'git') return w.run(o);
    commands.push(o);
    const result = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    if (o.args.join(' ') === '--version' && o.file === process.execPath) result.stdout = `v${process.versions.node}`;
    else if (o.file === 'go' && o.args[0] === 'version') result.stdout = 'go version go1.26.8 windows/amd64';
    else if (o.args.at(-1) === '--version') result.stdout = '12.1.0';
    if (o.file === 'go' && o.args[0] === 'build') { const file = o.args[o.args.indexOf('-o') + 1]; await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'MZ假的生产EXE'); }
    if (o.args.includes('build') && o.file === process.execPath) {
      for (const [name, value] of Object.entries({ 'dist/index.js': 'export{}', 'dist/ai-hook.js': 'export{}', 'dist/nikou-job.js': 'export{}', 'dist/console/assets/index.html': '<html></html>', 'dist/console/assets/vendor/marked.js': 'marked' })) {
        await mkdir(path.dirname(path.join(o.cwd, name)), { recursive: true }); await writeFile(path.join(o.cwd, name), value);
      }
    }
    if (o.args.includes('pack') && !o.args.includes('--dry-run')) {
      const assets = o.args[o.args.indexOf('--pack-destination') + 1];
      const files = { 'package/package.json': JSON.stringify({ name: 'nikou-cli', version: '1.0.0' }), 'package/dist/index.js': 'export{}', 'package/dist/ai-hook.js': 'export{}', 'package/dist/nikou-job.js': 'export{}', 'package/dist/console/assets/index.html': '<html></html>', 'package/dist/console/assets/vendor/marked.js': 'marked' };
      await writeFile(path.join(assets, 'nikou-cli-1.0.0.tgz'), makeTar(files));
      result.stdout = JSON.stringify([{ filename: 'nikou-cli-1.0.0.tgz' }]);
    }
    if (o.args.includes('integration-check')) result.stdout = JSON.stringify({ ok: true, protocol: 1, component: 'nikou', version: '1.0.0', nodeAbi: process.versions.modules });
    if (o.args.includes('nikou-self-check')) result.stdout = JSON.stringify({ ok: true, protocol: 1, component: 'magpie', version: '1.0.0' });
    return result;
  };
  const options = { ...w, run, npmCli: `${w.dir}/npm-cli.js`, platform: 'windows', arch: 'amd64', version: '1.0.0', hostPlatform: 'win32' };
  const evidence = await verify({ ...options, profile: 'source' });
  assert.equal(evidence.exitCode, 0, JSON.stringify(evidence));
  const built = await build({ ...options, sourceEvidence: evidence });
  assert.equal(built.exitCode, 0, JSON.stringify(built));
  return { ...w, options, built, evidence, commands, run };
}
