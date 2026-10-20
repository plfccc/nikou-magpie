import { spawn } from 'node:child_process';

export function runProcess({ file, args = [], cwd, timeoutMs = 30_000, env = process.env, input, onStdout, onStderr }) {
  if (typeof file !== 'string' || !Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new TypeError('执行器仅接受可执行文件和字符串参数数组');
  if (/\.(cmd|bat)$/i.test(file)) throw new TypeError('批处理入口需要专用适配；npm请使用node与npm-cli.js');
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false, done = false;
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    const finish = exitCode => { if (done) return; done = true; clearTimeout(timer); resolve({ exitCode, stdout, stderr, timedOut }); };
    const timer = setTimeout(() => {
      timedOut = true;
      // npm/测试入口还会拉起后代，仅结束父进程会遗留服务和被占用的输出管道。
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; onStdout?.(data); });
    child.stderr.on('data', data => { stderr += data; onStderr?.(data); });
    child.on('error', error => { stderr += error.message; finish(error.code === 'ENOENT' ? 127 : 1); });
    child.on('close', code => finish(timedOut ? 124 : (code ?? 1)));
  });
}

export function npmCommand({ nodeExecutable = process.execPath, npmCli, args = [], cwd, timeoutMs }) {
  if (!npmCli?.endsWith('npm-cli.js')) throw new TypeError('必须显式提供npm-cli.js路径');
  return { file: nodeExecutable, args: [npmCli, ...args], cwd, timeoutMs };
}
