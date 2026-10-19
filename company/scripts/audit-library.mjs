import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仅读取技能名称与路径，不输出可能携带凭据的 MCP 或 Agent 配置。
export function auditLibrary(home = os.homedir()) {
  const config = path.join(home, '.config', 'magpie');
  const library = JSON.parse(fs.readFileSync(path.join(config, 'library.json'), 'utf8'));
  const roots = {
    claude: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills'),
    codex: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'skills'),
    opencode: path.join(home, '.config', 'opencode', 'skills'),
    dsh: path.join(home, '.dsh', 'skills'),
    alma: path.join(home, '.config', 'alma', 'skills'),
  };
  const shared = path.join(home, '.agents', 'skills');
  const real = file => {
    const resolved = fs.realpathSync(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const issues = [];
  const agents = [];
  for (const [agent, dir] of Object.entries(roots)) {
    const expected = library.skills.filter(s => s.agents.includes(agent));
    if (!expected.length && !fs.existsSync(dir)) continue;
    let available = 0;
    let inherited = 0;
    for (const skill of expected) {
      const canonical = path.join(config, 'library', 'skills', skill.name);
      const own = path.join(dir, skill.name);
      const common = path.join(shared, skill.name);
      try {
        if (!fs.statSync(path.join(canonical, 'SKILL.md')).isFile()) throw Error('资源库缺少 SKILL.md');
        const viaShared = agent !== 'claude' && fs.existsSync(path.join(common, 'SKILL.md')) && real(common) === real(canonical);
        if (viaShared) {
          inherited++;
          if (fs.existsSync(own)) issues.push({ agent, skill: skill.name, reason: '共享目录与专属目录重复' });
        } else if (!fs.statSync(path.join(own, 'SKILL.md')).isFile() || real(own) !== real(canonical)) {
          throw Error('目标未链接到资源库');
        }
        available++;
      } catch (error) {
        issues.push({ agent, skill: skill.name, reason: error.message });
      }
    }
    agents.push({ agent, assigned: expected.length, available, inherited });
  }
  const names = library.skills.map(s => s.name);
  const duplicateNames = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
  return { ok: !issues.length && !duplicateNames.length, skills: names.length, agents, duplicateNames, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = auditLibrary();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`资源库检查失败：${error.message}\n`);
    process.exitCode = 1;
  }
}
