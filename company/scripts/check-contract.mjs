import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { sandbox } from './lib/evidence.mjs';
import { runProcess } from './lib/process.mjs';

export async function checkContract({ root, nikouDir }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nikou-magpie-contract-'));
  const isolated = await sandbox(temporary); let child;
  try {
    const localFixture = await readFile(path.join(root, 'company/tests/fixtures/nikou-bridge-v1.json'));
    const upstreamFixture = await readFile(path.join(nikouDir, 'test/fixtures/nikou-bridge-v1.json'));
    if (!localFixture.equals(upstreamFixture)) throw Error('双端共享夹具字节不一致');
    const probe = path.join(temporary, process.platform === 'win32' ? 'probe.exe' : 'probe');
    const built = await runProcess({ file: 'go', args: ['build', '-o', probe, './company/tests/fixtures/console-probe'], cwd: root, timeoutMs: 120_000 });
    if (built.exitCode !== 0) throw Error('Go 实际协议探针构建失败');
    const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port; await new Promise(resolve => server.close(resolve));
    const env = { ...isolated.env, NIKOU_ACCOUNT_BACKEND: 'magpie', NIKOU_CONSOLE_AUTO_START: '0', NIKOU_WORKER_SUPERVISOR: 'console', NIKOU_MAGPIE_BIN: probe };
    child = spawn(process.execPath, [path.join(nikouDir, 'dist/index.js'), 'hook', 'console', '--port', String(port)], { cwd: nikouDir, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => finish(Error('隔离控制台启动超时')), 20_000);
      const data = chunk => { output += chunk; if (output.includes(`http://127.0.0.1:${port}/`)) finish(); };
      const failed = () => finish(Error('隔离控制台未成功启动'));
      function finish(error) { clearTimeout(timer); child.stdout.off('data', data); child.off('error', failed); child.off('exit', failed); if (error) reject(error); else resolve(); }
      child.stdout.on('data', data); child.stderr.resume(); child.once('error', failed); child.once('exit', failed);
    });
    const result = await runProcess({ file: probe, args: [`http://127.0.0.1:${port}`, path.join(isolated.env.USERPROFILE, '.nikou-block/console/token')], cwd: root, env, timeoutMs: 20_000 });
    if (result.exitCode !== 0) throw Error('Go 与 Nikou 实际协议联调失败');
    const replies = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    if (replies.length !== 2 || replies.some(r => r.protocol !== 1 || !r.ok || !r.requestId) || replies[0].data.service !== 'nikou-console' || !replies[0].data.instanceId || !replies[1].data.status || !replies[1].data.scopes) throw Error('双端实际信封或状态字段不匹配');
    return { ok: true, protocol: 1, checks: ['共享夹具字节一致', 'Go实际hello', 'Go实际status', '隔离控制台未启动Worker'] };
  } finally {
    if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const root = process.cwd(); const result = await checkContract({ root, nikouDir: path.resolve(process.argv[2] ?? '../nikou-cli-integration') }); process.stdout.write(`${JSON.stringify(result)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
