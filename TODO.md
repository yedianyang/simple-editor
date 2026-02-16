# TODO.md — FieldCorder 任务列表

## Tauri 迁移计划

### Phase 1: 基础搭建 — ✅ 已完成

| # | 任务 | 负责人 | 状态 |
|---|------|--------|------|
| 1.1 | 初始化 Tauri 项目（保留现有 src/ 前端） | generator | ✅ 完成 |
| 1.2 | Rust 后端：文件系统 API（open/save dialog, read/write） | generator | ✅ 完成 |
| 1.3 | Rust 后端：WAV 解析 + localfile:// 协议 | generator | ✅ 完成 |
| 1.4 | 前端适配层：TauriAPI 替代 electronAPI | template | ✅ 完成 |
| 1.5 | 验证 304MB WAV 加载无 OOM | tester | ⏳ 待验证 |

### Phase 2: 核心功能迁移 — 进行中

| # | 任务 | 负责人 | 状态 |
|---|------|--------|------|
| 2.1 | Rust 后端：非 WAV 格式音频解码（FLAC/MP3/OGG） | generator | 待开始 |
| 2.2 | Rust 后端：AudioUnit 插件扫描/加载（rack crate 或 FFI） | generator | 待开始 |
| 2.3 | 菜单系统迁移（Tauri menu API） | generator | ✅ 完成 |
| 2.4 | 前端：IPC 事件监听迁移（onImportFiles 等） | template | ✅ 完成 |
| 2.5 | 窗口配置：titlebar、traffic light、resize | designer | 待开始 |

### Phase 3: 完善与打包 (Week 3-4)

| # | 任务 | 负责人 | 状态 |
|---|------|--------|------|
| 3.1 | Tauri 打包 DMG（签名 + 公证配置） | generator | 待开始 |
| 3.2 | 全功能测试（导入/导出/编辑/混音/插件） | tester | 待开始 |
| 3.3 | 性能测试（大文件、内存占用、启动速度） | tester | 待开始 |
| 3.4 | UI 适配（WKWebView 兼容性修复） | template | 待开始 |
| 3.5 | 文档更新（README、开发指南、CLAUDE.md） | docs | 待开始 |
| 3.6 | 代码审查（Rust + TypeScript） | code-reviewer | 待开始 |

## 已完成 (Tauri 版)

| 任务 | 完成时间 |
|------|----------|
| Tauri 项目初始化 + Rust 后端 | 2026-02-16 |
| Rust WAV 解析器（16/24/32bit PCM + Float32） | 2026-02-16 |
| localfile:// 自定义协议 | 2026-02-16 |
| TauriAPI 前端适配层 | 2026-02-16 |
| Rust 原生菜单系统（完整快捷键） | 2026-02-16 |
| IPC 事件监听迁移 | 2026-02-16 |
| 播放头点击定位修复（DPR 坐标） | 2026-02-16 |
| 拖动文字选中修复（user-select: none） | 2026-02-16 |
| 插件浏览器 UI 入口 + ⌘B 快捷键 | 2026-02-16 |
| 暂停后播放头位置同步修复 | 2026-02-16 |

## 已完成 (Electron 版)

| 任务 | 完成时间 |
|------|----------|
| P0 黑屏修复 | 2026-02-16 |
| AU 原生插件调研 | 2026-02-16 |
| AU 原生插件 N-API 实现 | 2026-02-16 |
| 原生 addon 编译 + 扫描验证 (40 AU) | 2026-02-16 |
| DMG 打包 (180MB) | 2026-02-16 |
| 音频导入性能优化 (FFT/Metering 异步化) | 2026-02-16 |
| 大文件 OOM 修复 (手动 WAV 解析) | 2026-02-16 |
| 拖放导航修复 | 2026-02-16 |
| Mixer 默认隐藏修复 | 2026-02-16 |
| Tauri vs Electron 方案对比调研 | 2026-02-16 |
| Mac App Store 分发调研 | 2026-02-16 |

## Bug 列表

| Bug | 说明 | 状态 |
|------|------|------|
| 暂停后点击新位置再播放跳回旧位置 | play() 在 isPaused 时直接 resume，未检查播放头是否移动 | ✅ 已修复 |

## 备注

- Debug 二进制约 34MB（Electron 版 180MB DMG）
- Tauri dev 启动命令：`npm run tauri:dev`
- Electron 旧代码备份在 `electron-backup/`
- 计划双版本：MAS Lite (无原生插件) + DMG Pro (AU/VST)
- 用户尚未订阅 Apple Developer Program
