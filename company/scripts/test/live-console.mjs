import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 仅用于显式本机联调；所有控制台用户目录均为临时目录。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const nikou = path.resolve(process.argv[2] ?? path.join(root, '../nikou-cli-integration'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nikou-live-console-'));
const goDir = path.join(root, '.scratch', 'live-console');
fs.mkdirSync(goDir, { recursive: true });
const token = 'isolated-live-console-token-1234567890';
const tokenPath = path.join(temporary, 'token');
fs.writeFileSync(tokenPath, token);
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const entry = path.join(temporary, 'console.mjs');
fs.writeFileSync(entry, `import { startConsoleServer } from ${JSON.stringify(pathToFileURL(path.join(nikou, 'src/console/server.ts')).href)}; await startConsoleServer({ port: ${port}, token: ${JSON.stringify(token)} }); console.log('READY');`);
const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(nikou, 'node_modules/tsx/dist/loader.mjs')).href, entry], {
  cwd: nikou, env: { ...process.env, HOME: temporary, USERPROFILE: temporary, APPDATA: temporary, LOCALAPPDATA: temporary }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('控制台启动超时')), 20000);
    const interval = setInterval(() => { if (output.includes('READY')) { clearTimeout(timeout); clearInterval(interval); resolve(); } }, 50);
    child.once('exit', code => { clearTimeout(timeout); clearInterval(interval); reject(new Error(`控制台退出 ${code}: ${output}`)); });
  });
  fs.writeFileSync(path.join(goDir, 'main.go'), `package main
import("context";"encoding/json";"os";"time";"github.com/yetone/magpie/internal/nikou")
func main(){c,e:=nikou.NewConsoleClient(os.Args[1],os.Args[2]);if e!=nil{panic(e)};ctx,cancel:=context.WithTimeout(context.Background(),10*time.Second);defer cancel();h:=c.Hello(ctx);s:=c.Status(ctx);if !h.OK||!s.OK{panic("真实双端请求失败")};data:=s.Data.(map[string]any);state:=data["status"].(map[string]any);if state["workerStatus"]!="stopped"{panic("隔离环境出现运行中 Worker")};json.NewEncoder(os.Stdout).Encode(map[string]any{"hello":h.OK,"status":s.OK,"protocol":h.Protocol,"workerStatus":state["workerStatus"]})}
`);
  await new Promise((resolve, reject) => {
    const go = spawn(process.env.NIKOU_GO_BIN ?? 'go', ['run', './.scratch/live-console', `http://127.0.0.1:${port}`, tokenPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let result = '';
    const timeout = setTimeout(() => { go.kill(); reject(new Error('Go 联调超时')); }, 60000);
    go.stdout.on('data', chunk => { result += chunk; });
    go.stderr.on('data', chunk => { result += chunk; });
    go.on('exit', code => { clearTimeout(timeout); if (code) reject(new Error(result)); else { console.log(result.trim()); resolve(); } });
    go.on('error', error => { clearTimeout(timeout); reject(error); });
  });
} finally {
  child.kill();
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.rmSync(goDir, { recursive: true, force: true });
}
