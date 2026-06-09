# Agent Skill Doctor：让你的 AI Agent 技能库健康运行

> 你的 AI Agent 有多少技能？哪些在用，哪些已经"僵尸"了？

## 背景

随着 Claude Code、Codex、Cursor 等 AI Agent 平台的普及，我们会在各种目录下积累大量的 Skill 文件。时间一长，问题就来了：

- **重复技能**：同一个功能装了好几份，散落在不同目录
- **僵尸技能**：装了但从没用过，也不知道该不该删
- **来源混乱**：分不清哪些是官方的、哪些是插件装的、哪些是自己写的
- **风险未知**：有些技能可能包含危险的 shell 命令或网络请求

手动管理？太累了。所以我们做了 **Agent Skill Doctor**——一个专为 AI Agent Skills 设计的诊断与治理工具。

## 核心功能

### 一键扫描

```bash
agent-skill-doctor scan
```

自动扫描 `~/.agents`、`~/.claude`、`~/.codex` 等目录下的所有技能，构建 SQLite 数据库。支持识别技能来源：

| 分类 | 说明 | 示例 |
|------|------|------|
| **官方** | anthropics/openai/google 官方技能 | pdf、pptx、yeet |
| **插件** | 通过插件安装的技能 | obra/superpowers 的系列技能 |
| **第三方** | 其他来源或未知来源 | 各种社区技能 |

### 智能诊断

```bash
agent-skill-doctor diagnose
```

一次检测六大问题：

1. **僵尸技能**：基于 6 个加权因子的评分系统（0.0-1.0），自动识别废弃技能
2. **重复技能**：三种策略检测（完全重复、同源重复、同名重复）
3. **版本漂移**：同一技能在不同位置有不同版本
4. **风险检测**：扫描 shell 命令、网络请求、凭证泄露等风险模式
5. **冲突检测**：识别互相矛盾的技能指令
6. **描述质量**：评估技能描述的完整度

### 僵尸评分机制

僵尸检测不是简单的"没用过就是僵尸"，而是综合考虑多个维度：

| 因子 | 权重 | 说明 |
|------|------|------|
| 未加入预设 | +0.25 | 不在任何 preset 中 |
| 未安装到 Agent | +0.20 | 没有 agent 使用它 |
| 未安装到项目 | +0.20 | 没有项目引用它 |
| 无近期修改 | +0.15 | 文件很久没动过 |
| 无活动日志 | +0.15 | 没有使用记录 |
| 描述质量差 | +0.05 | 描述过于简单 |

更重要的是，**来源保护机制**：

- 官方技能（anthropics/openai）：分数归零，完全保护
- 插件技能（obra/superpowers）：分数 ×0.5
- 第三方技能：分数 ×0.75

这意味着官方和插件技能不会被误判为僵尸。

### 可视化报告

```bash
agent-skill-doctor report --format html --lang zh
```

生成自包含的 HTML 报告，支持：

- **双语切换**：中英文一键切换
- **仪表盘**：按优先级排列的问题概览（红色=高危，黄色=中危，灰色=信息）
- **技能分类**：按来源分类的技能列表，带颜色标签
- **僵尸详情**：每个僵尸技能的评分因子分解
- **修复建议**：可复制的 Agent 提示词，直接粘贴给 Agent 使用

## 与 Agent 联动

这是 Agent Skill Doctor 最大的亮点——**诊断结果可以直接交给 Agent 自动修复**。

### 方式一：使用 fix 命令

```bash
# 生成所有问题的修复提示词
agent-skill-doctor fix --lang zh

# 只修复高风险问题
agent-skill-doctor fix --type risk --severity high --lang zh

# 只清理僵尸技能
agent-skill-doctor fix --type zombie --lang zh
```

输出的提示词包含：
- 具体问题描述
- 涉及的技能路径
- 修复建议和操作步骤

直接复制给 Agent，Agent 会根据具体情况进行修复。

### 方式二：HTML 报告内复制

1. 生成 HTML 报告
2. 打开报告，查看「修复建议」部分
3. 点击「复制」按钮，将提示词粘贴给 Agent

### 方式三：直接对话

```
请帮我清理 agent-skill-doctor 检测出的僵尸技能：

运行命令：
agent-skill-doctor zombies --json

对于评分 >= 0.7 的技能，建议移除。
对于评分 0.4-0.7 的技能，帮我审查后决定。
```

## 实战案例

### 案例 1：清理重复技能

```bash
# 扫描诊断
agent-skill-doctor scan
agent-skill-doctor duplicates --json

# 输出：
# [
#   {
#     "strategy": "exact_duplicate",
#     "members": [
#       { "slug": "browser", "local_path": "~/.claude/skills/skills/browser" },
#       { "slug": "browser", "local_path": "~/.agents/skills/skills/browser" }
#     ]
#   }
# ]

# 删除冗余副本
rm -rf ~/.claude/skills/skills/browser

# 验证
agent-skill-doctor duplicates --json
# 输出：[]
```

### 案例 2：识别技能来源

扫描后的 HTML 报告会显示每个技能的来源分类：

- 🟢 **官方**：pdf、pptx、yeet 等（来自 anthropics/openai）
- 🟣 **插件**：brainstorming、systematic-debugging 等（来自 obra/superpowers）
- 🟡 **第三方**：其他来源的技能

### 案例 3：僵尸技能清理

```bash
# 查看僵尸技能（按分数排序）
agent-skill-doctor zombies --json

# 输出示例：
# [
#   { "slug": "analyze", "score": 0.85, "level": "strong_suspicious_zombie" },
#   { "slug": "build-fix", "score": 0.60, "level": "suspicious_zombie" }
# ]

# 生成清理提示词
agent-skill-doctor fix --type zombie --lang zh
```

## 安装使用

### npm 安装

```bash
npm install -g agent-skill-doctor
```

### 从源码安装

```bash
git clone https://github.com/sljdxde/agent-skill-doctor.git
cd agent-skill-doctor
npm link
```

### 快速开始

```bash
# 扫描
agent-skill-doctor scan --lang zh

# 诊断
agent-skill-doctor diagnose --lang zh

# 生成报告
agent-skill-doctor report --format html --lang zh

# 查看重复
agent-skill-doctor duplicates

# 查看僵尸
agent-skill-doctor zombies
```

### CI/CD 集成

```bash
# 在 CI 中，高风险时失败
agent-skill-doctor diagnose --ci --fail-on high

# 生成制品报告
agent-skill-doctor report --format json --output ./skill-report.json
```

## 技术特点

- **零依赖**：纯 Node.js 实现，无需安装额外包
- **SQLite 存储**：使用 Node.js 22.5.0+ 内置的实验性 `node:sqlite` 模块
- **自包含报告**：HTML 报告内联所有 CSS/JS，无外部依赖
- **安全设计**：只读操作，不会修改任何技能文件
- **可扩展**：支持自定义风险规则（JSON 格式）

## 项目地址

- GitHub: https://github.com/sljdxde/agent-skill-doctor
- npm: https://www.npmjs.com/package/agent-skill-doctor

## 总结

Agent Skill Doctor 不只是一个扫描工具，它是一个完整的技能治理方案：

1. **发现问题**：扫描 + 诊断，全面检测六大问题
2. **理解问题**：可视化报告，清晰展示问题详情
3. **解决问题**：与 Agent 联动，一键生成修复提示词

让你的 AI Agent 技能库始终保持健康状态。

---

*Made by [@sljdxde](https://github.com/sljdxde)*
