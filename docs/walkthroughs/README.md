# Code Walkthroughs

代码走查文档，帮助理解模块如何工作。

## 何时创建

- 理解新加入的复杂模块
- vibe coding 后需要理解实现细节
- 为新成员提供代码导览
- 调研某个子系统的工作原理

## 创建方式

**使用 AI agent：**
```
Create a linear walkthrough of [模块名] in docs/walkthroughs/[模块名].md
Use sed/grep/cat to include code snippets, don't copy-paste code.
Explain the flow, key design decisions, and component interactions.
```

## 文档格式

文件命名：`[模块名].md`（例如：`audio-engine.md`, `wiener-filter.md`）

```markdown
# [模块名] Walkthrough

**创建日期**: YYYY-MM-DD
**覆盖范围**: [列出涉及的文件]

## 概述

简述模块功能和在系统中的位置。

## 核心流程

按执行顺序讲解：

### 步骤 1: 初始化

[解释] + 代码片段

### 步骤 2: 主要逻辑

[解释] + 代码片段

## 关键设计决策

- 为什么这样实现
- 考虑的权衡

## 相关模块

- 依赖的其他模块
- 被哪些模块调用
```

## 示例

参考 Simon Willison 的 [Present App Walkthrough](https://github.com/simonw/present/blob/main/walkthrough.md)。
