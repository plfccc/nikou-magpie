import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export class IntegrationError extends Error {
  constructor(exitCode, message, code = 'INTEGRATION_ERROR') { super(message); this.exitCode = exitCode; this.code = code; }
}
export function validateLock(lock, { mode } = {}) {
  const bad = message => ({ ok: false, exitCode: 2, message });
  if (lock?.schemaVersion !== 1 || lock.bridgeProtocol !== 1) return bad('锁版本或桥接协议无效');
  if (!lock.magpie?.repository || !sha(lock.magpie.commit)) return bad('magpie必须锁定完整SHA与来源');
  const n = lock.nikou;
  if (!n || n.package !== 'nikou-cli' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(n.version)) return bad('Nikou必须锁定精确包版本');
  if (n.registryGitHead !== undefined && !sha(n.registryGitHead)) return bad('registryGitHead必须是完整SHA');
  if (n.mode === 'artifact') {
    if (n.sourceVerified !== false || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(n.integrity ?? '')) return bad('artifact模式要求完整性与未验证源码标记');
    if (mode === 'source') return { ok: false, exitCode: 11, message: '源码来源未验证，不能用于源码构建' };
  } else if (n.mode === 'source') {
    if (n.sourceVerified !== true || !n.repository || !sha(n.commit) || !sha(n.effectiveCommit) || !/^[0-9a-f]{64}$/.test(n.dependencyLock?.sha256 ?? '') || n.dependencyLock?.path !== 'package-lock.json') return bad('source模式缺少已验证来源、完整SHA或依赖锁摘要');
  } else return bad('未知Nikou来源模式');
  return { ok: true, exitCode: 0 };
}

export async function loadContext(options = {}) {
  const root = await realpath(options.root ?? process.cwd());
  const lockPath = path.resolve(root, options.lockPath ?? 'company/upstreams.lock.json');
  const policyPath = path.resolve(root, options.policyPath ?? 'company/upstreams.policy.json');
  const lockBytes = options.lock ? Buffer.from(JSON.stringify(options.lock)) : await readFile(lockPath);
  const policyBytes = options.policy ? Buffer.from(JSON.stringify(options.policy)) : await readFile(policyPath);
  const lock = options.lock ?? JSON.parse(lockBytes);
  const policy = options.policy ?? JSON.parse(policyBytes);
  const validation = validateLock(lock, { mode: options.mode });
  if (!validation.ok) throw new IntegrationError(validation.exitCode, validation.message, 'LOCK_INVALID');
  if (policy.schemaVersion !== 1) throw new IntegrationError(2, 'policy版本无效');
  const nikouDir = path.resolve(root, options.nikouDir ?? policy.nikou?.workspace ?? '../nikou-cli');
  return { ...options, root, lockPath, policyPath, lockBytes, policyBytes, lock, policy, nikouDir };
}

export function allowedSource(policy, component, repository) {
  const config = policy[component];
  if (!repository || repository.startsWith('-') || !config?.allowedRepositories?.includes(repository) || repository !== config.repository) throw new IntegrationError(11, `${component}来源不在允许列表`, 'SOURCE_DENIED');
  return config;
}

export function failure(error) { return { ok: false, exitCode: error.exitCode ?? 2, diagnostics: [{ status: 'error', code: error.code ?? 'INVALID_INPUT', message: error.message }] }; }
