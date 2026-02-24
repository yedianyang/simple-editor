# ⚠️ DEPRECATED — 此文件已废弃（2026-02-22）
# 任务管理 → 使用 TaskCreate/TaskList/TaskUpdate（Claude Code 内建）
# 保留此文件仅作历史参考，**不要修改或读取此文件做决策**

---

# TODO.md — FieldCorder 任务列表（历史记录）

## 功能升级：多 Track 时间线 + 声能图 + UI 重构 — ✅ 全部完成

### Phase 1: 数据模型基础 — ✅ 完成

| # | 任务 | 负责人 | 状态 | 文件 |
|---|------|--------|------|------|
| 1 | Timeline/Track/Clip/PooledBuffer 接口 | generator | ✅ 完成 | `src/core/types.ts` |
| 2 | BufferPool — mono AudioBuffer 池管理 | generator | ✅ 完成 | `src/core/BufferPool.ts` |
| 3 | TimelineModel — Timeline/Track/Clip CRUD | generator | ✅ 完成 | `src/core/TimelineModel.ts` |
| 4 | TimelineUndoManager — 命令模式 undo/redo | generator | ✅ 完成 | `src/utils/TimelineUndoManager.ts` |

### Phase 2: AudioEngine 多 Track 播放 — ✅ 完成

| # | 任务 | 负责人 | 状态 | 文件 |
|---|------|--------|------|------|
| 5 | Track routing + playTimeline + Fader Law + Crossfader | generator | ✅ 完成 | `src/core/AudioEngine.ts` |

### Phase 3: Timeline 渲染器 — ✅ 完成

| # | 任务 | 负责人 | 状态 | 文件 |
|---|------|--------|------|------|
| 6 | 多 Track lane + Clip 波形 + 交互 | template | ✅ 完成 | `src/editor/TimelineRenderer.ts` |

### Phase 4: 声能图 (Sonogram) — ✅ 完成

| # | 任务 | 负责人 | 状态 | 文件 |
|---|------|--------|------|------|
| 7 | Web Worker STFT 计算 | template | ✅ 完成 | `src/editor/sonogram-worker.ts` |
| 8 | iZotope RX 风格热力图渲染 | template | ✅ 完成 | `src/editor/SonogramRenderer.ts` |

### Phase 5: UI 布局重构 — ✅ 完成

| # | 任务 | 负责人 | 状态 | 文件 |
|---|------|--------|------|------|
| 9 | HTML 三栏布局 (文件浏览器 + 编辑区 + 元数据) | designer | ✅ 完成 | `src/index.html` |
| 10 | CSS 新布局样式 | designer | ✅ 完成 | `src/styles/main.css` |
| 11 | Rust scan_folder + open_folder_dialog | generator | ✅ 完成 | `src-tauri/src/lib.rs`, `src/utils/TauriAPI.ts` |

### Phase 6: Mixer 适配 — ✅ 完成

| # | 任务 | 负责人 | 状态 | 文件 |
|---|------|--------|------|------|
| 12 | Track 模式 + Fader Law UI + Crossfader UI | generator | ✅ 完成 | `src/mixer/Mixer.ts` |

### Phase 7: 集成 + 验证 — ✅ 完成

| # | 任务 | 负责人 | 状态 | 文件 |
|---|------|--------|------|------|
| 13 | App.ts 全功能集成 | template | ✅ 完成 | `src/ui/App.ts` |
| 14 | TypeScript 编译 0 错误 + Vite 构建 31 模块 | lead | ✅ 完成 | — |

### 完成统计

- **+3,363 / -594 行代码**，10 个修改文件 + 8 个新文件
- **新增文件**: BufferPool.ts, TimelineModel.ts, TimelineRenderer.ts, SonogramRenderer.ts, sonogram-worker.ts, TimelineUndoManager.ts, docs/ui-wireframe.md
- **完成日期**: 2026-02-16

---

## Tauri 迁移计划 (已完成/进行中)

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

### Phase 3: 完善与打包

| # | 任务 | 负责人 | 状态 |
|---|------|--------|------|
| 3.1 | Tauri 打包 DMG（签名 + 公证配置） | generator | 待开始 |
| 3.2 | 全功能测试 | tester | 待开始 |
| 3.3 | 性能测试 | tester | 待开始 |
| 3.4 | UI 适配（WKWebView 兼容性修复） | template | 待开始 |
| 3.5 | 文档更新 | docs | 待开始 |
| 3.6 | 代码审查 | code-reviewer | 待开始 |

---

## 已完成

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

---

*最后更新：2026-02-16*
