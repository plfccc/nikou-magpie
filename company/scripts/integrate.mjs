#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from './lib/doctor.mjs';
import { checkUpstreams, writeReport } from './lib/report.mjs';
import { sync } from './lib/sync.mjs';
import { IntegrationError, failure } from './lib/lock.mjs';
import { verify } from './lib/verify.mjs';
import { build } from './lib/build.mjs';
import { packageRelease, releasePlan } from './lib/package.mjs';
import { installRelease, rollbackRelease } from './lib/install.mjs';
import { planMigration, applyMigration, restoreMigration } from './lib/migration.mjs';
import { launchInstalled } from './lib/runtime.mjs';
import { planProfile, applyProfile } from './lib/profile.mjs';

const usage = '用法：node company/scripts/integrate.mjs doctor --mode source|artifact --json\n      node company/scripts/integrate.mjs check-upstreams --channel stable --out artifacts/upstreams/candidate.json\n      node company/scripts/integrate.mjs sync --from-report 文件 --component magpie|nikou|both [--dry-run] [--resume]\n      node company/scripts/integrate.mjs verify --profile source|artifacts|install [--allow-dirty]\n      node company/scripts/integrate.mjs build --platform windows --arch amd64 --version x.y.z\n      node company/scripts/integrate.mjs package --version x.y.z\n      node company/scripts/integrate.mjs release-plan --version x.y.z --manifest 路径';
const runtimeUsage = '\n      install --manifest <绝对路径> --install-root <绝对目录> --offline\n      rollback --transaction <ID> --install-root <绝对目录> --offline\n      run --component magpie|console --install-root <绝对目录> [--port 19736]\n      migrate plan|apply|restore（显式配置路径与确认参数见company/docs/migration.md）\n      profile plan|apply（网关模型白名单导入，参数见company/docs/update.md）';
export async function main(argv = process.argv.slice(2)) {
  try {
    const [command, ...rawArgs] = argv;
    const migrationAction = ['migrate', 'profile'].includes(command) ? rawArgs[0] : undefined;
    const args = ['migrate', 'profile'].includes(command) ? rawArgs.slice(1) : rawArgs;
    if (command === '--help' || command === 'help') return { exitCode: 0, message: usage + runtimeUsage };
    const common = ['json', 'root', 'nikou-dir'];
    const allowed = { doctor: ['mode', ...common], 'check-upstreams': ['channel', 'out', ...common], sync: ['from-report', 'component', 'dry-run', 'resume', 'out', ...common], verify: ['profile', 'allow-dirty', 'build-file', 'manifest', 'install-evidence', 'npm-cli', ...common], build: ['platform', 'arch', 'version', 'source-evidence', 'npm-cli', ...common], package: ['version', 'build-file', 'artifacts-evidence', ...common], 'release-plan': ['version', 'manifest', 'install-evidence', 'channel', ...common], install: ['manifest', 'install-root', 'offline', ...common], rollback: ['transaction', 'install-root', 'offline', ...common] };
    allowed.migrate = ['settings-path', 'worker-config-path', 'runtime-scopes-path', 'master-credentials-path', 'managed-dir', 'migration-id', 'request-id', 'old-process-ids', 'offline', 'private-directory-confirmed', ...common];
    allowed.run = ['component', 'install-root', 'port', ...common];
    allowed.profile = ['worker-config-path', 'gateway-url', 'api-key-env', 'models-json', 'model', 'api-type', 'out', 'from-plan', 'managed-dir', 'offline', 'private-directory-confirmed', 'confirmed', ...common];
    if (!allowed[command]) throw new IntegrationError(2, `未支持命令：${command ?? ''}\n${usage}`);
    if (command === 'migrate' && !['plan', 'apply', 'restore'].includes(migrationAction)) throw new IntegrationError(2, 'migrate必须选择plan、apply或restore');
    if (command === 'profile' && !['plan', 'apply'].includes(migrationAction)) throw new IntegrationError(2, 'profile必须选择plan或apply');
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      const flag = args[i].replace(/^--/, '');
      if (!args[i].startsWith('--') || !allowed[command].includes(flag) || flag in flags) throw new IntegrationError(2, `参数无效或重复：${args[i]}`);
      if (['json', 'dry-run', 'resume', 'allow-dirty', 'offline', 'private-directory-confirmed', 'confirmed'].includes(flag)) flags[flag] = true;
      else { const value = args[++i]; if (!value || value.startsWith('--')) throw new IntegrationError(2, `参数缺少值：--${flag}`); flags[flag] = value; }
    }
    const options = { root: path.resolve(flags.root ?? process.cwd()), nikouDir: flags['nikou-dir'], npmCli: flags['npm-cli'], buildFile: flags['build-file'], sourceEvidenceFile: flags['source-evidence'], artifactEvidenceFile: flags['artifacts-evidence'], manifest: flags.manifest, installEvidenceFile: flags['install-evidence'] };
    if (command === 'run') return launchInstalled({ installRoot: flags['install-root'], component: flags.component, port: flags.port === undefined ? 19736 : Number(flags.port) });
    if (command === 'profile') {
      if (migrationAction === 'plan') {
        const plan = await planProfile({ workerConfigPath: flags['worker-config-path'], gatewayUrl: flags['gateway-url'], apiKeyEnv: flags['api-key-env'], models: flags['models-json'] ? JSON.parse(flags['models-json']) : undefined, model: flags.model, apiType: flags['api-type'] });
        if (flags.out) await writeReport(path.resolve(options.root, flags.out), plan);
        return { exitCode: 0, plan };
      }
      if (!flags['from-plan']) throw new IntegrationError(2, 'profile apply需要--from-plan');
      const plan = JSON.parse(await readFile(path.resolve(options.root, flags['from-plan']), 'utf8'));
      return { exitCode: 0, ...applyProfile({ plan, managedDir: flags['managed-dir'], confirmed: flags.confirmed === true, offlineConfirmed: flags.offline === true, privateDirectoryConfirmed: flags['private-directory-confirmed'] === true }) };
    }
    if (command === 'migrate') {
      const migration = { settingsPath: flags['settings-path'], workerConfigPath: flags['worker-config-path'], runtimeScopesPath: flags['runtime-scopes-path'], masterCredentialsPath: flags['master-credentials-path'], managedDir: flags['managed-dir'], migrationId: flags['migration-id'], requestId: flags['request-id'], oldProcessIds: flags['old-process-ids']?.split(',').map(Number), offlineConfirmed: flags.offline === true, privateDirectoryConfirmed: flags['private-directory-confirmed'] === true };
      const result = migrationAction === 'plan' ? planMigration(migration) : migrationAction === 'apply' ? applyMigration(migration) : restoreMigration(migration);
      return { exitCode: 0, ...result };
    }
    if (command === 'doctor') {
      if (flags.mode && !['artifact', 'source'].includes(flags.mode)) throw new IntegrationError(2, 'mode必须为source或artifact');
      return doctor({ ...options, mode: flags.mode ?? 'source' });
    }
    if (command === 'check-upstreams') return checkUpstreams({ ...options, channel: flags.channel ?? 'stable', out: flags.out });
    if (command === 'verify') return verify({ ...options, profile: flags.profile, allowDirty: flags['allow-dirty'] });
    if (command === 'build') return build({ ...options, platform: flags.platform, arch: flags.arch, version: flags.version, sourceEvidenceFile: flags['source-evidence'] });
    if (command === 'package') return packageRelease({ ...options, version: flags.version, artifactEvidenceFile: flags['artifacts-evidence'] });
    if (command === 'release-plan') return releasePlan({ ...options, version: flags.version, channel: flags.channel });
    if (command === 'install') {
      if (!flags.manifest || !flags['install-root'] || flags.offline !== true || !path.isAbsolute(flags.manifest) || !path.isAbsolute(flags['install-root'])) throw new IntegrationError(2, 'install必须指定绝对--manifest、绝对--install-root和--offline');
      return installRelease({ manifestPath: flags.manifest, installRoot: flags['install-root'], offline: true });
    }
    if (command === 'rollback') {
      if (!flags.transaction || !flags['install-root'] || flags.offline !== true || !path.isAbsolute(flags['install-root'])) throw new IntegrationError(2, 'rollback必须指定--transaction、绝对--install-root和--offline');
      return rollbackRelease({ transactionId: flags.transaction, installRoot: flags['install-root'], offline: true });
    }
    if (!flags['from-report'] || !flags.component) throw new IntegrationError(2, 'sync必须指定--from-report与--component');
    const report = JSON.parse(await readFile(path.resolve(options.root, flags['from-report']), 'utf8'));
    const result = await sync({ ...options, report, component: flags.component, dryRun: flags['dry-run'], resume: flags.resume });
    if (flags.out) await writeReport(path.resolve(options.root, flags.out), result);
    return result;
  } catch (error) { return failure(error); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main(); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = result.exitCode;
}
