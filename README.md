<div align="center">

# Agent Skill Doctor

*AI Agent Skills 诊断与治理工具——让你的 Skills 健康运行*

[![License](https://img.shields.io/badge/License-MIT-3B82F6?style=for-the-badge)](./LICENSE)
[![npm](https://img.shields.io/npm/v/agent-skill-doctor?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/agent-skill-doctor)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.5.0-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Zero Deps](https://img.shields.io/badge/Zero-Dependencies-10B981?style=for-the-badge)](#features)

</div>

---

Agent Skill Doctor 是一个专为 AI Agent Skills 设计的诊断与治理工具。它能扫描、分析、检测问题，并生成优化计划，确保你的 Skills 生态健康有序。

支持 Claude Code · Codex · OpenCode · Cursor 等平台的 Skills 管理。

## 功能

| 名字 | 一句话 |
|---|---|
| **Scan** | 扫描本地 Skill 目录，构建 SQLite 数据库 |
| **Diagnose** | 诊断质量问题、重复、漂移、风险、冲突和僵尸 Skill |
| **Report** | 生成 HTML / Markdown / JSON 格式报告（支持中英文切换） |
| **Guide** | 输出修复指南，包含可直接给 Agent 的提示词 |
| **Fix** | 快速生成针对性 Agent 提示词，支持按类型/严重程度筛选 |
| **Plan** | 生成安全的优化计划，带预期状态验证 |
| **Apply** | 执行变更，支持 dry-run 安全检查 |
| **CI** | 支持 CI/CD 集成，提供退出码 |
| **i18n** | CLI 输出和报告支持中文/英文 |

## 安装

### npm 安装（推荐）

```bash
npm install -g agent-skill-doctor
```

### 从源码安装

```bash
git clone https://github.com/sljdxde/agent-skill-doctor.git
cd agent-skill-doctor
npm link
```

## 快速开始

```bash
# 扫描并诊断
agent-skill-doctor scan
agent-skill-doctor diagnose --json

# 生成 HTML 报告（支持中英文切换）
agent-skill-doctor report --format html --lang zh
agent-skill-doctor report --format html --lang en

# 查看修复指南（可直接复制提示词给 Agent）
agent-skill-doctor guide --lang zh

# 快速修复（生成针对性 Agent 提示词）
agent-skill-doctor fix --lang zh
agent-skill-doctor fix --type risk --severity high
```

### 常用命令

```bash
# 扫描特定目录
agent-skill-doctor scan --root ~/.skills-manager/skills --json

# 中文输出
agent-skill-doctor diagnose --lang zh

# 查找重复
agent-skill-doctor duplicates

# 检测风险
agent-skill-doctor risks

# 检测冲突
agent-skill-doctor conflicts

# 检测僵尸 Skill
agent-skill-doctor zombies

# 快速修复（按类型/严重程度筛选）
agent-skill-doctor fix --type risk --lang zh
agent-skill-doctor fix --severity high --lang zh
agent-skill-doctor fix --type zombie --severity medium

# 生成优化计划
agent-skill-doctor plan --safe --json --output ./plan.json

# 预览变更（dry-run）
agent-skill-doctor apply ./plan.json --dry-run
```

### CI/CD 集成

```bash
# 在 CI 中，高风险时失败
agent-skill-doctor diagnose --ci --fail-on high

# 生成制品报告
agent-skill-doctor report --format json --output ./skill-report.json
```

## 与 Agent 联动修复

诊断完成后，你可以将结果交给 AI Agent 自动修复问题：

### 方式一：使用 fix 命令（推荐）

`fix` 命令会针对每个有问题的 Skill 生成详细的 Agent 提示词，包含具体问题描述和修复建议：

```bash
# 修复所有问题
agent-skill-doctor fix --lang zh

# 只修复高风险问题
agent-skill-doctor fix --type risk --severity high --lang zh

# 只修复僵尸 Skill
agent-skill-doctor fix --type zombie --lang zh
```

输出的提示词可以直接复制给 Agent，Agent 会根据具体问题进行针对性修复。

### 方式二：使用 HTML 报告的修复指南

1. 生成 HTML 报告：`agent-skill-doctor report --format html --lang zh`
2. 打开报告，查看底部的「修复建议」部分
3. 每个问题类型都有：问题含义、修复步骤、可复制的 Agent 提示词
4. 点击「复制」按钮，将提示词粘贴给 Agent 即可

### 方式三：使用 guide 命令

```bash
# 查看所有问题类型的修复指南
agent-skill-doctor guide --lang zh

# 将指南输出重定向给 Agent
agent-skill-doctor guide --lang zh > /tmp/guide.txt
```

### 方式四：直接将诊断结果发给 Agent

```
请帮我修复 agent-skill-doctor 诊断出的问题：

运行命令：
agent-skill-doctor diagnose --json

根据输出的 findings，逐个修复：
- risk 类型：添加安全防护
- zombie 类型：清理或更新僵尸技能
- duplicate 类型：合并重复技能
- conflict 类型：解决冲突指令
- description_quality 类型：完善技能描述
```

## 项目结构

```
agent-skill-doctor/
├── bin/                    # CLI 入口
│   ├── agent-skill-doctor.js          # 主 CLI
│   ├── agent-skill-doctor-phase2.js   # Phase 2 分析（调试用）
│   ├── agent-skill-doctor-phase3.js   # Phase 3 冲突检测（调试用）
│   └── agent-skill-doctor-risk.js     # 风险扫描（调试用）
├── src/doctor/             # 核心库模块
│   ├── index.js            # 主导出
│   ├── i18n.js             # 中英文国际化
│   ├── phase2.js           # 重复/漂移检测
│   ├── conflict.js         # 冲突检测
│   ├── zombie.js           # 僵尸检测
│   ├── risk-lite.js        # 风险扫描
│   └── rules.js            # 规则和工具
├── rules/default/          # 默认风险规则
│   ├── credential-risk.json
│   ├── destructive-risk.json
│   └── shell-network-risk.json
├── test/                   # 测试文件
└── package.json            # 包配置
```

## 库使用

除了 CLI，你也可以将 agent-skill-doctor 作为 Node.js 库使用：

```javascript
const {
  detectDuplicateGroups,
  detectVersionDrift,
  detectConflicts,
  detectZombies,
  scanSkillForRisks,
  loadJsonRules,
  DEFAULT_CONFLICT_RULES
} = require('agent-skill-doctor');

// 或导入特定模块
const phase2 = require('agent-skill-doctor/phase2');
const conflict = require('agent-skill-doctor/conflict');
const zombie = require('agent-skill-doctor/zombie');
const risk = require('agent-skill-doctor/risk');
```

### API 示例

```javascript
// 检测重复
const duplicates = detectDuplicateGroups(skills);

// 检测版本漂移
const drift = detectVersionDrift(skills);

// 检测冲突
const conflicts = detectConflicts(skills, DEFAULT_CONFLICT_RULES);

// 检测僵尸
const zombies = detectZombies(skills);
const score = computeZombieScore(skill); // 0.0 - 1.0，越高越可能是僵尸

// 风险扫描
const rules = loadJsonRules('./rules/default');
const risks = scanSkillForRisks(skills[0], rules);
```

## 配置

### 数据目录

默认位置：

```
~/.agent-skill-doctor/
  doctor.db
  reports/
```

通过环境变量覆盖：

```bash
AGENT_SKILL_DOCTOR_HOME=/tmp/asd agent-skill-doctor scan
```

### 自定义风险规则

```bash
agent-skill-doctor diagnose --rules ./my-custom-rules
```

规则应为 JSON 文件，格式参考 `rules/default/`。

## 环境要求

- Node.js >= 22.5.0（使用实验性 `node:sqlite` 模块）
- 零外部依赖

## 安全性

此实现不会写入 `skills-manager.db`，也不会删除或覆盖 Skill 文件。任何未来的写操作必须先通过 dry-run 计划和预期状态验证。

## 故障排除

### Node.js 版本错误

如果看到 "ExperimentalWarning: SQLite is an experimental feature"：

```bash
node --version  # 应 >= 22.5.0
```

### 全局安装权限错误

```bash
npx agent-skill-doctor scan
```

### 数据库锁定错误

```bash
rm ~/.agent-skill-doctor/doctor.db
agent-skill-doctor scan
```

## 发布

### 自动发布（推荐）

1. 在 GitHub 仓库设置中添加 `NPM_TOKEN` secret
2. 在 GitHub Actions 中手动触发 "Version Bump" workflow，选择 patch/minor/major
3. 自动 bump 版本、打 tag、发布到 npm

### 手动发布

```bash
npm login
npm version patch  # 或 minor / major
git push --tags
npm publish
```

## Contributing

1. Fork 仓库
2. 创建功能分支
3. 提交变更
4. 运行测试：`npm test`
5. 提交 Pull Request

## 链接

- [GitHub 仓库](https://github.com/sljdxde/agent-skill-doctor)
- [npm 包](https://www.npmjs.com/package/agent-skill-doctor)
- [Issue 追踪](https://github.com/sljdxde/agent-skill-doctor/issues)
- [设计文档](https://github.com/sljdxde/agent-skill-doctor/blob/main/docs/DESIGN-PHASE1.md)
- [更新日志](CHANGELOG.md)

## License

[MIT License](./LICENSE) · 自由使用 / 修改 / 再分发

Made by [@sljdxde](https://github.com/sljdxde)
