import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { resolveInstalled } from './install.mjs';
import { failure, IntegrationError } from './lock.mjs';

export async function runtimeCommand({ installRoot, component, port = 19736, env = process.env }) {
  if (!['magpie', 'console'].includes(component) || !Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535) throw new IntegrationError(2, '运行组件或控制台端口无效');
  const installed = await resolveInstalled(installRoot);
  const { directory, manifest } = installed;
  const magpie = path.join(directory, manifest.components.magpie.entry);
  const runtimeEnv = { ...env, NIKOU_MANAGED_RUNTIME: '1', NIKOU_ACCOUNT_BACKEND: 'magpie', NIKOU_MAGPIE_BIN: magpie, NIKOU_WORKER_SUPERVISOR: 'console', NIKOU_CONSOLE_PORT: String(port) };
  // 旧监督器的文件交接不能泄漏进公司运行时。
  delete runtimeEnv.NIKOU_WORKER_RESTART_REQUEST_PATH;
  return { file: component === 'magpie' ? magpie : path.join(directory, manifest.components.nikou.node),
    args: component === 'magpie' ? [] : [path.join(directory, manifest.components.nikou.entry), 'hook', 'console', '--port', String(port)],
    cwd: directory, env: runtimeEnv, pointer: installed.pointer };
}
async function portInUse(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new IntegrationError(14, '控制台端口探测超时，拒绝重复启动')); });
    socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(false); else reject(error); });
  });
}
export async function launchInstalled(options = {}) {
  try {
    const spec = await runtimeCommand(options);
    if (options.component === 'console' && await portInUse(Number(options.port ?? 19736))) throw new IntegrationError(12, '控制台端口已被占用，请使用现有控制台或先停止旧进程');
    return await new Promise(resolve => {
      const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true, shell: false, stdio: 'inherit' });
      const interrupt = () => child.kill();
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      const cleanup = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); };
      child.once('error', () => { cleanup(); resolve(failure(new IntegrationError(14, '公司组件启动失败'))); });
      child.once('exit', (code, signal) => { cleanup(); resolve({ exitCode: code ?? 1, ok: code === 0, signal, transactionId: spec.pointer.transactionId }); });
    });
  } catch (error) { return failure(error); }
}
