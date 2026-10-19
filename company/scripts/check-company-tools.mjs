import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const registry = 'http://repo.hszq8.com/repository/npm-hst/';

// 仅读取元数据，不能启动 hst-mcp --version，也不能采信 nb 的硬编码版本。
export async function checkCompanyTools({ globalRoot, fetchMetadata = fetch } = {}) {
  if (!globalRoot) {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    globalRoot = (await exec(process.execPath, [npmCli, 'root', '-g'], { windowsHide: true, timeout: 15000 })).stdout.trim();
  }
  return Promise.all(['hst-mcp', 'nikou-node'].map(async name => {
    const item = { name, source: registry, installed: null, latest: null, state: 'unknown' };
    try {
      const pkg = JSON.parse(await readFile(path.join(globalRoot, name, 'package.json'), 'utf8'));
      if (pkg.name !== name || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw Error('本机包元数据无效');
      item.installed = pkg.version;
    } catch (error) {
      if (error.code !== 'ENOENT') { item.error = '无法读取本机包元数据'; return item; }
    }
    try {
      // Nexus hosted 不一定实现 /latest 路由，读取包元数据的 dist-tags。
      const response = await fetchMetadata(registry + name, { signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const metadata = await response.json();
      const latest = metadata['dist-tags']?.latest;
      if (!/^\d+\.\d+\.\d+$/.test(latest || '')) throw Error('版本响应无效');
      item.latest = latest;
      const compare = item.installed && latest.split('.').map(Number).reduce((result, n, i) => result || Math.sign(n - Number(item.installed.split('.')[i])), 0);
      item.state = !item.installed ? 'not-installed' : compare > 0 ? 'update-available' : compare < 0 ? 'local-newer' : 'current';
    } catch { item.error = '私服查询失败，请检查公司网络；未确认是否最新'; }
    return item;
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), tools: await checkCompanyTools() }, null, 2));
}
