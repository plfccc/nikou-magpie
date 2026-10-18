import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../scripts/lib/process.mjs';

test('维护命令超时终止整棵测试进程树，不遗留持有输出管道的后代', { timeout: 15_000 }, async () => {
  const code = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true}); process.stdout.write(String(c.pid)); setInterval(()=>{},1000);`;
  const result = await runProcess({ file: process.execPath, args: ['-e', code], timeoutMs: 2000 });
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  const pid = Number(result.stdout.trim()); assert.ok(Number.isInteger(pid) && pid > 0);
  let alive = true;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, '超时后代进程仍在运行');
});
