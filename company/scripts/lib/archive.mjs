import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { IntegrationError, digest } from './lock.mjs';

export async function tarEntries(file) {
  let tar;
  try { tar = gunzipSync(await readFile(file), { maxOutputLength: 512 * 1024 * 1024 }); } catch { throw new IntegrationError(15, 'npm包不是有效gzip归档'); }
  const entries = new Map();
  let pending = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const block = tar.subarray(offset, offset + 512); if (block.every(n => n === 0)) break;
    const str = (start, end) => block.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    let name = str(0, 100); const prefix = str(345, 500); if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(124, 136).trim(), 8); const type = str(156, 157) || '0';
    const expected = parseInt(str(148, 156).trim(), 8); const copy = Buffer.from(block); copy.fill(32, 148, 156);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length || copy.reduce((a, b) => a + b, 0) !== expected) throw new IntegrationError(15, 'npm包tar头部或大小损坏');
    const content = tar.subarray(offset + 512, offset + 512 + size);
    if (type === 'x') {
      pending = {};
      for (let p = 0; p < content.length;) {
        const space = content.indexOf(32, p); const length = Number(content.subarray(p, space).toString());
        if (space < p || !Number.isInteger(length) || length <= space - p + 1 || p + length > content.length) throw new IntegrationError(15, 'npm包PAX头损坏');
        const field = content.subarray(space + 1, p + length - 1).toString('utf8'); const equal = field.indexOf('=');
        if (equal < 1) throw new IntegrationError(15, 'npm包PAX字段损坏'); pending[field.slice(0, equal)] = field.slice(equal + 1); p += length;
      }
      offset += 512 + Math.ceil(size / 512) * 512; continue;
    }
    name = pending.path ?? name;
    if (pending.size !== undefined && Number(pending.size) !== size) throw new IntegrationError(15, 'npm包PAX大小不一致');
    pending = {};
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || !name.startsWith('package/') || !['0', '5'].includes(type)) throw new IntegrationError(15, 'npm包包含非法路径、链接或未支持tar条目');
    if (type === '0') { if (entries.has(name)) throw new IntegrationError(15, 'npm包有重复条目'); entries.set(name, tar.subarray(offset + 512, offset + 512 + size)); }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
export async function inspectPackage(file, expected, resources) {
  const entries = await tarEntries(file);
  for (const file of ['package.json', 'dist/index.js', 'dist/ai-hook.js', 'dist/nikou-job.js', 'dist/console/assets/index.html']) if (!entries.get(`package/${file}`)?.length) throw new IntegrationError(15, `npm包缺少资源：${file}`);
  let pkg; try { pkg = JSON.parse(entries.get('package/package.json')); } catch { throw new IntegrationError(15, 'npm包元数据损坏'); }
  if (pkg.name !== expected.package || pkg.version !== expected.version) throw new IntegrationError(15, 'npm包身份/版本不匹配');
  if (!resources?.length || !resources.some(r => r.path === 'dist/console/assets/index.html')) throw new IntegrationError(15, '构建未记录控制台完整资源');
  for (const resource of resources) if (digest(entries.get(`package/${resource.path}`) ?? '') !== resource.sha256) throw new IntegrationError(15, `npm包控制台资源缺失或变更：${resource.path}`);
  return { package: pkg.name, version: pkg.version, files: entries.size };
}
