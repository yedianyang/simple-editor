# Code Examples

可复用的代码示例和概念验证。

## 目的

**"Hoard things you know how to do"** — 积累解决方案，作为未来 AI agent 的输入材料。

当需要实现新功能时，agent 可以：
1. 搜索这个目录中的已有示例
2. 组合两个或多个示例构建新功能
3. 避免从零开始重新发明轮子

## 何时添加

- 调研新技术时的 PoC 代码
- 解决特定问题的小工具
- 可能在其他地方复用的代码片段
- 第三方库的使用示例

## 文件组织

```
examples/
├── audio/                # 音频处理示例
│   ├── fft-demo.ts
│   └── wiener-filter-poc.ts
├── ui/                   # UI 组件示例
│   └── waveform-canvas.html
├── tauri/                # Tauri 集成示例
│   └── file-dialog-rust.rs
└── README.md
```

## 命名规范

- 单文件示例：`功能描述.扩展名`
- 多文件示例：`功能描述/` 目录

## 文档要求

每个示例文件开头包含：
```typescript
/**
 * [示例标题]
 * 
 * 用途：[简短描述]
 * 技术：[使用的库/API]
 * 创建日期：YYYY-MM-DD
 * 
 * 使用方式：
 * [如何运行或集成]
 */
```

## 如何使用

**让 AI 组合示例：**
```
Look at examples/audio/fft-demo.ts and examples/ui/waveform-canvas.html.
Combine them to build a real-time spectrum analyzer.
```

## 参考

- [Simon Willison's tools collection](https://tools.simonwillison.net)
- [Agentic Engineering: Hoard and Recombine](https://simonwillison.net/guides/agentic-engineering-patterns/hoard-things-you-know-how-to-do/)
