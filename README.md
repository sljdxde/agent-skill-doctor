<div align="center">

# Agent Skill Doctor

AI Agent Skills 诊断与治理工具，适用于 Claude Code、Codex、Cursor、OpenCode 等本地 Agent Skill 目录。

[![License](https://img.shields.io/badge/License-MIT-3B82F6?style=for-the-badge)](./LICENSE)
[![npm](https://img.shields.io/npm/v/agent-skill-doctor?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/agent-skill-doctor)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.5.0-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Zero Deps](https://img.shields.io/badge/Zero-Dependencies-10B981?style=for-the-badge)](#安装)

中文 · [English](./README.en.md)

</div>

---

Agent Skill Doctor 用来帮你检查本地 AI Agent Skills 是否健康：有没有重复安装、版本漂移、互相冲突、危险指令、僵尸 Skill、描述不清等问题。它不会直接删除或覆盖你的 Skill 文件；默认只诊断、出报告、给 Agent 修复提示词。

## 它能诊断什么

- `risk`：危险能力提示，例如 `rm -rf`、读取 `.env`、`curl/wget`、`powershell`、`child_process`。
- `conflict`：Skill 之间的指令冲突，例如一个要求 `npm install`，另一个要求 `pnpm install`。
- `duplicate`：重复 Skill，包含完全重复、同源重复、同名不同内容。
- `version_drift`：同一个 Skill 在多个位置存在不同版本、不同 ref 或不同内容。
- `governance`：Registry / 团队共享就绪度，例如缺少 owner、version、生命周期状态、stable/dev 标签或可信来源。
- `freshness`：技能是否需要更新，例如无来源 URL（无法检查更新）、来源未锁定 ref/commit、修改时间过长（>180 天）疑似落后上游、同源副本版本更低。`--check-upstream` 可联网用 `git ls-remote` 验证 commit 是否落后上游 HEAD。
- `zombie`：疑似长期不用或无人维护的 Skill。
- `description_quality`：缺少触发条件、输入输出、风险说明，或者描述过短。
- `scan_warning`：目录结构问题，例如缺少 `SKILL.md` 或 frontmatter 格式异常。

## 评分和判定规则

- 风险等级来自规则文件：破坏性文件操作通常是 `critical`，凭据访问和远程下载通常是 `high`，shell 执行通常是 `medium`。
- 重复检测有三个策略：完全相同内容 `confidence=1.0`，同一来源和 slug `confidence=0.95`，同名但内容不同 `confidence=0.7`。
- 僵尸评分范围是 `0.0 - 1.0`，分数越高越可疑：
  - 未出现在 preset：`+0.25`
  - 未安装到任何 agent：`+0.20`
  - 未安装到任何项目：`+0.20`
  - 近期未修改：`+0.15`
  - 无活动记录：`+0.15`
  - 描述质量过低：`+0.05`
- 僵尸保护规则：`pinned/keep/core/system` 标签直接归零；官方来源归零；插件来源分数乘 `0.5`；第三方插件来源分数乘 `0.75`。
- 僵尸阈值：`>=0.8` 是强疑似僵尸，`>=0.6` 是疑似僵尸，`>=0.4` 是低活跃。
- 描述质量从 60 分起算；描述过短、没有触发条件、没有输入输出、风险未说明都会扣分并生成提示。

## 安装

```bash
npm install -g agent-skill-doctor
```

不想全局安装也可以直接用：

```bash
npx agent-skill-doctor help
```

要求 Node.js `>= 22.5.0`，因为工具使用 `node:sqlite`。

## 快速开始：让 Agent 使用它

推荐把 Agent Skill Doctor 当成 Agent 的诊断工具，而不是只当作人手动运行的 CLI。直接把下面这段发给 Claude Code、Codex、Cursor Agent 或其他本地 Agent：

```text
请使用 agent-skill-doctor 诊断我的本地 Agent Skills：

1. 运行：npx agent-skill-doctor diagnose --lang zh
2. 生成 HTML 报告：npx agent-skill-doctor report --format html --lang zh
3. 阅读报告中的冲突、重复、版本漂移、僵尸和风险项。
4. 先不要删除文件。请先输出修复计划，并说明每一步会改哪些 Skill。
5. 对 risk / duplicate / version_drift / zombie / description_quality 分别给出建议。
```

Agent 可以继续用 `fix` 生成更具体的修复提示词：

```bash
npx agent-skill-doctor fix --lang zh
npx agent-skill-doctor fix --type risk --severity high --lang zh
npx agent-skill-doctor fix --type zombie --lang zh
```

默认扫描范围包含常见 Agent Skill 目录：

```text
~/.agent/skills
~/.agents/skills
~/.agents/skills-core
~/.codex/skills
~/.claude/skills
~/.cursor/skills
~/.opencode/skills
```

如需扫描特定目录：

```bash
npx agent-skill-doctor diagnose --root ./my-skills --lang zh
```

## 本地可复现案例

仓库内带了一个脱敏演示目录：`examples/readme-demo-skills`。它包含 5 个小 Skill，用来触发风险、冲突、重复、版本漂移、僵尸和描述质量问题。

```bash
npm install
npm run start -- diagnose --root ./examples/readme-demo-skills --rebuild-index --lang zh
```

实际输出示例：

```text
技能数: 5
发现数: 15
风险发现: 3
冲突发现: 1
僵尸技能: 5
```

其中：

- `dangerous-deploy` 会触发 `rm -rf`、`.env`、`curl` 三类风险。
- `npm-installer` 和 `pnpm-installer` 会触发包管理器冲突、同源重复和版本漂移。
- `markdown-reporter-a` 和 `markdown-reporter-b` 会触发完全重复。
- `Dangerous Deploy` 的描述过短，会触发描述质量问题。

生成针对 Agent 的风险修复提示词：

```bash
npm run start -- fix --type risk --lang zh
```

CLI 实际输出会显示你的本机路径；下面是 README 中脱敏后的展示格式：

```text
技能: dangerous-deploy (./examples/readme-demo-skills/dangerous-deploy)
- [critical] Possible destructive filesystem operation
- [high] Possible credential access
- [high] Possible remote download or installer execution
```

## HTML 报告和语言切换

生成中文 HTML：

```bash
npm run start -- report --format html --lang zh --output ./reports/skill-doctor.zh.html
```

生成英文 HTML：

```bash
npm run start -- report --format html --lang en --output ./reports/skill-doctor.en.html
```

HTML 报告包含：

- 扫描概览和严重程度分布
- Skill 列表和来源信息
- 按类型分组的问题详情
- 修复路径
- 可复制的 Agent Prompt
- 报告内语言切换按钮

## 常用命令

```bash
# 扫描并写入本地诊断数据库
agent-skill-doctor scan --lang zh

# 完整诊断
agent-skill-doctor diagnose --lang zh
agent-skill-doctor diagnose --json

# 只看某类问题
agent-skill-doctor risks --json
agent-skill-doctor conflicts --json
agent-skill-doctor duplicates --json
agent-skill-doctor governance --json
agent-skill-doctor zombies --json

# 更新检测（离线）
agent-skill-doctor freshness --json

# 更新检测（联网验证上游 commit）
agent-skill-doctor diagnose --check-upstream --lang zh

# 生成报告
agent-skill-doctor report --format md --lang zh
agent-skill-doctor report --format json --output ./skill-report.json
agent-skill-doctor report --format html --lang zh

# 生成修复提示词
agent-skill-doctor fix --lang zh
agent-skill-doctor fix --type duplicate --lang zh
agent-skill-doctor fix --type version_drift --lang zh
agent-skill-doctor fix --type governance --lang zh

# CI 中按严重程度失败
agent-skill-doctor diagnose --ci --fail-on high

# 生成优化计划并 dry-run
agent-skill-doctor plan --safe --json --output ./plan.json
agent-skill-doctor apply ./plan.json --dry-run
```

## 数据目录

默认写入：

```text
~/.agent-skill-doctor/
  doctor.db
  reports/
```

可以用环境变量改到项目内或临时目录：

```bash
AGENT_SKILL_DOCTOR_HOME=./.doctor-data agent-skill-doctor diagnose --lang zh
```

PowerShell：

```powershell
$env:AGENT_SKILL_DOCTOR_HOME = ".\.doctor-data"
agent-skill-doctor diagnose --lang zh
```

## 自定义风险规则

```bash
agent-skill-doctor diagnose --rules ./rules/default --lang zh
```

规则文件是 JSON，参考 `rules/default/`。

## 作为 Node.js 库使用

```js
const {
  detectDuplicateGroups,
  detectVersionDrift,
  detectConflicts,
  detectZombies,
  detectFreshnessFindings,
  scanSkillForRisks,
  loadJsonRules,
  DEFAULT_CONFLICT_RULES
} = require('agent-skill-doctor');
```

## 安全边界

- 不写入 `skills-manager.db`。
- 不默认删除、移动或覆盖 Skill 文件。
- `apply` 当前只支持 `--dry-run`。
- 风险项不一定是 bug；它们通常表示该 Skill 需要高权限，应该由人或 Agent 明确确认。

## 故障排除

```bash
# Node 版本
node --version

# 无全局安装权限时
npx agent-skill-doctor diagnose --lang zh

# 清理诊断数据库后重扫
rm ~/.agent-skill-doctor/doctor.db
agent-skill-doctor diagnose --lang zh
```

PowerShell 删除数据库：

```powershell
Remove-Item "$env:USERPROFILE\.agent-skill-doctor\doctor.db" -Force
agent-skill-doctor diagnose --lang zh
```

## 链接

- [GitHub](https://github.com/sljdxde/agent-skill-doctor)
- [npm](https://www.npmjs.com/package/agent-skill-doctor)
- [更新日志](./CHANGELOG.md)
- [许可证](./LICENSE)
