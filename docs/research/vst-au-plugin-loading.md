# VST/AU 原生插件加载方案调研报告

**调研时间**: 2026-02-16
**调研员**: researcher
**项目**: FieldCorder DAW

---

## 目录

1. [背景与需求](#背景与需求)
2. [现有实现分析](#现有实现分析)
3. [技术方案对比](#技术方案对比)
4. [推荐方案](#推荐方案)
5. [实施路线图](#实施路线图)
6. [风险与挑战](#风险与挑战)
7. [参考资料](#参考资料)

---

## 背景与需求

FieldCorder 是一个基于 Electron + TypeScript + Web Audio API 的轻量级 DAW。当前插件系统（`src/plugins/PluginHost.ts`）仅实现了 Web Audio API 内置效果器（EQ、压缩器、混响等），缺少对 macOS 原生 **VST3** 和 **AudioUnit** 插件的支持。

### 核心需求

- 在 Electron 环境中加载系统已安装的 VST3/AU 插件
- 支持插件扫描、实例化、参数控制
- 实时音频处理（低延迟 < 10ms）
- 兼容 Electron 的安全架构（sandbox、contextBridge）

---

## 现有实现分析

项目已有 **N-API native addon 框架** (`native/` 目录)，包含：

- **CMakeLists.txt**: 已配置 AudioToolbox、AudioUnit、CoreAudio 框架链接，支持可选的 VST3 SDK
- **addon.cpp**: N-API 入口，暴露 `loadPlugin`、`setParameter`、`processAudio` 等接口
- **plugin_host.h/cpp**: 插件宿主骨架，`loadAudioUnit()` 和 `loadVST3()` 均为 **TODO 占位实现**，仅提取文件名返回

**当前状态**: 框架完整，但核心加载逻辑缺失（AudioUnit 组件查找、VST3 SDK 集成）。

---

## 技术方案对比

### 方案 1: 直接实现 N-API + AudioUnit/VST3 SDK

#### 实现路径

**AudioUnit 部分**（macOS 原生）:

1. 使用 `AudioComponentFindNext` 扫描系统 AU 插件（路径：`/Library/Audio/Plug-Ins/Components/`, `~/Library/Audio/Plug-Ins/Components/`）
2. 用 `AudioComponentInstanceNew` 创建插件实例
3. 调用 `AudioUnitInitialize` 初始化
4. 通过 `AudioUnitGetProperty` 查询参数列表
5. 用 `AudioUnitSetParameter` 修改参数
6. 在音频回调中调用 `AudioUnitRender` 处理音频

**VST3 部分**（需要 VST3 SDK）:

1. 集成 [Steinberg VST3 SDK](https://github.com/steinbergmedia/vst3sdk)（MIT License）
2. 加载 `.vst3` bundle，获取 `IComponent` 和 `IEditController` 接口
3. 查询参数、处理音频缓冲区

#### 优点

- **性能最优**: 直接调用原生 API，无额外抽象层
- **完全可控**: 可定制所有细节（参数映射、UI 通信）
- **依赖最少**: AU 部分无需外部库（系统自带框架）

#### 缺点

- **开发量大**: 需要深入理解 AudioUnit 和 VST3 架构（估计 3-4 周全职开发）
- **调试复杂**: C++ 与 JS 的异步通信、内存管理易出错
- **VST3 SDK 集成**: 需要正确配置构建系统，处理跨平台头文件

#### 实现难度

- **AudioUnit**: ⭐⭐⭐ (中等，Apple 官方文档齐全)
- **VST3**: ⭐⭐⭐⭐ (较高，SDK 较复杂)
- **时间估计**: 3-5 周（含测试）

---

### 方案 2: 基于 JUCE 框架 + N-API 桥接

#### 实现路径

1. 集成 [JUCE](https://github.com/juce-framework/JUCE) 框架（GPLv3 或商业许可）
2. 使用 JUCE 的 `AudioProcessorGraph` 和 `PluginHostType` 类
3. 通过 N-API 包装 JUCE 的插件加载、参数控制、音频处理接口
4. 借鉴 [node-audio](https://github.com/ramirezd42/node-audio) 项目架构（已用 JUCE 实现 PluginNode）

#### 优点

- **快速开发**: JUCE 已实现 VST3/AU/AAX 的统一抽象，代码量减少 60-70%
- **稳定可靠**: JUCE 是行业标准（Pro Tools、Reaper 等使用），经过数千插件验证
- **跨平台潜力**: 未来可扩展到 Windows VST3（虽然当前只需 macOS）
- **参考实现**: JUCE 自带 `AudioPluginHost` 示例，可直接参考

#### 缺点

- **许可证问题**:
  - GPLv3 要求开源整个项目（FieldCorder 目前未声明许可证）
  - 商业许可 $900/年（个人）或 $2200/年（企业）
- **包体积增大**: JUCE 框架约 10-15MB（编译后）
- **二次抽象**: JUCE API → N-API → TypeScript，调试链路较长

#### 实现难度

- **JUCE 集成**: ⭐⭐ (简单，CMake 配置)
- **N-API 桥接**: ⭐⭐⭐ (中等，需处理异步回调)
- **时间估计**: 1-2 周（含测试）

---

### 方案 3: 直接使用开源项目（vst-js / node-audio）

#### 现有项目评估

**[vst-js](https://github.com/ramirezd42/vst-js)**

- **功能**: 加载 VST3 插件（含 GUI），在独立进程运行
- **状态**: ⚠️ **实验阶段**，仅支持 macOS，9 个未关闭 issue（含安装失败问题）
- **架构**: Native addon + 进程隔离
- **风险**: 项目最后更新 2024 年初，维护不活跃

**[node-audio](https://github.com/ramirezd42/node-audio)**

- **功能**: 基于 JUCE + LabSound 的图形化音频 API，支持 PluginNode
- **状态**: ⚠️ **极度实验性**，大量功能未实现，AU 支持是 [open issue](https://github.com/ramirezd42/node-audio/issues/9)
- **问题**: M1 Mac 兼容性问题、仅 VST3、文档缺失

#### 优点

- **快速原型**: 如果能跑起来，可立即验证可行性
- **参考价值**: 可学习其 N-API 绑定和 JUCE 集成方式

#### 缺点

- **生产不可用**: 两个项目都明确标注"实验性"，bug 多、维护停滞
- **定制困难**: 代码质量参差，改动风险高
- **无 AU 支持**: vst-js 不支持 AU，node-audio 的 AU 是待办事项

#### 推荐度

⛔ **不推荐用于生产**，但可作为技术参考（研究其 N-API 绑定和线程模型）

---

### 方案 4: 混合方案（AU 原生 + VST3 延后）

#### 实现策略

**阶段 1: 优先实现 AudioUnit**

- 仅实现 AU 加载（macOS 用户主要使用 AU 插件）
- 使用方案 1 的直接 API 调用
- 预计 1-2 周完成基础功能

**阶段 2: VST3 支持（可选）**

- 根据用户反馈决定是否集成 VST3 SDK
- 或采用方案 2（JUCE）统一两种格式

#### 优点

- **快速上线**: AU 实现简单，可先满足核心需求
- **降低风险**: 避免一次性投入大量时间到复杂的 VST3 集成
- **灵活调整**: 根据实际使用情况决定下一步

#### 缺点

- **功能不完整**: 部分用户可能需要 VST3 插件（如 Kontakt 仅有 VST3 版本）
- **代码重构**: 后续加入 VST3 可能需要重构架构

---

## 音频实时性分析

### 关键挑战

1. **线程模型**:
   - Electron 的 Node.js 主线程 ≠ 实时音频线程
   - Web Audio API 的 `AudioWorklet` 运行在独立的高优先级线程
   - Native addon 的音频处理必须在 **AudioWorklet 的音频线程** 中执行

2. **数据传递**:
   - 已知问题: Electron 中 `Nan::NewBuffer` 传递大缓冲区性能差 ([Issue #11479](https://github.com/electron/electron/issues/11479))
   - 解决方案: 使用 **SharedArrayBuffer** 或 **直接在 native 层与 Web Audio 桥接**

3. **最佳实践**:
   - 在 C++ 层实现音频回调，直接处理 `AudioBuffer`
   - 参数变化通过 `AudioParam` 或 lock-free queue 传递
   - 避免在音频线程中分配内存、锁、或 JS 调用

### 推荐架构

```
┌─────────────────────────────────────────────────┐
│  TypeScript (主线程)                            │
│  - UI 控制                                       │
│  - 参数调整 → AudioParam.setValueAtTime()       │
└──────────────────┬──────────────────────────────┘
                   │ IPC (Electron)
┌──────────────────▼──────────────────────────────┐
│  Native Addon (Main Process)                    │
│  - 插件扫描、加载                                │
│  - 参数映射                                      │
└──────────────────┬──────────────────────────────┘
                   │ Shared Memory
┌──────────────────▼──────────────────────────────┐
│  AudioWorklet Processor (实时线程)              │
│  - 直接调用 AU/VST3 的 render 函数              │
│  - Lock-free 参数更新                           │
└─────────────────────────────────────────────────┘
```

---

## Electron Sandbox 兼容性

### 问题

- Electron 的 **sandbox 模式** 禁用 Node.js，无法加载 native addon
- **Context Isolation** 要求通过 `contextBridge` 暴露 API

### 解决方案

1. **在 BrowserWindow 中禁用 sandbox**:
   ```typescript
   new BrowserWindow({
     webPreferences: {
       nodeIntegration: false,
       contextIsolation: true,
       sandbox: false,  // 允许 native addon
       preload: path.join(__dirname, 'preload.js')
     }
   })
   ```

2. **在 preload.js 中通过 contextBridge 暴露 API**:
   ```typescript
   contextBridge.exposeInMainWorld('electronAPI', {
     loadPlugin: (path: string) => ipcRenderer.invoke('load-plugin', path),
     setPluginParameter: (...) => ipcRenderer.invoke('set-param', ...)
   })
   ```

3. **安全性补偿**:
   - 启用 CSP (Content Security Policy)
   - 验证所有 IPC 输入
   - 限制可加载插件的路径（白名单机制）

---

## 推荐方案

### 🥇 首选方案: **方案 4（AU 优先 + 未来可选 JUCE）**

#### 理由

1. **快速验证**: 1-2 周实现 AU 支持，立即满足 macOS 用户核心需求
2. **技术风险低**: AudioUnit API 成熟稳定，文档齐全
3. **灵活扩展**: 后续可根据需求选择：
   - 直接实现 VST3（方案 1）
   - 引入 JUCE 统一两者（方案 2）
4. **避免许可证陷阱**: AU 部分无需第三方库，不涉及 JUCE 的 GPLv3 问题

### 🥈 备选方案: **方案 2（JUCE 全栈）**

#### 适用场景

- 项目愿意采用 GPLv3 开源
- 或有预算购买 JUCE 商业许可
- 计划未来支持 Windows VST3

---

## 实施路线图

### Phase 1: AudioUnit 基础支持 (1-2 周)

**Week 1**:
- [ ] 实现 `PluginHost::loadAudioUnit()` 的插件扫描和加载
  - [ ] `AudioComponentFindNext` 遍历系统 AU 插件
  - [ ] `AudioComponentInstanceNew` + `AudioUnitInitialize` 创建实例
  - [ ] 查询插件参数列表（`AudioUnitGetPropertyInfo`）
- [ ] 完成 N-API 绑定的参数控制接口
- [ ] 单元测试（加载 macOS 自带的 AUBandpass、AUDelay 等）

**Week 2**:
- [ ] 实现音频处理回调
  - [ ] 在 native 层处理 `AudioUnitRender`
  - [ ] 与 Web Audio API 的 `AudioWorkletProcessor` 桥接
- [ ] 参数自动化（AudioParam 映射）
- [ ] 前端 UI 集成（插件列表、参数面板）
- [ ] 性能测试（延迟、CPU 占用）

### Phase 2: VST3 支持（可选，2-3 周）

- [ ] 集成 VST3 SDK（如选择方案 1）或引入 JUCE（方案 2）
- [ ] 实现 `loadVST3()` 逻辑
- [ ] VST3 GUI 支持（可选）

### Phase 3: 优化与稳定性（1 周）

- [ ] 多插件链路测试
- [ ] 内存泄漏检测（Valgrind/Instruments）
- [ ] 崩溃恢复机制（插件加载失败处理）

---

## 风险与挑战

### 高风险项

| 风险点 | 影响 | 缓解措施 |
|--------|------|----------|
| **音频线程阻塞** | 导致爆音、卡顿 | 使用 lock-free 数据结构，避免主线程操作 |
| **插件崩溃** | 导致整个应用崩溃 | 考虑插件进程隔离（如 vst-js 的方案） |
| **VST3 SDK 复杂度** | 开发周期延长 | 先实现 AU，VST3 可后续迭代 |
| **Electron 版本兼容** | N-API 变更导致重新编译 | 使用稳定的 N-API 版本（N-API 8） |

### 中风险项

| 风险点 | 影响 | 缓解措施 |
|--------|------|----------|
| **插件 GUI 显示** | 部分插件需要原生窗口 | Phase 1 仅支持参数控制，GUI 延后 |
| **插件格式多样性** | AU v2/v3、VST2/VST3 | 优先支持主流格式（AU v2, VST3） |
| **参数映射不准确** | 插件参数类型复杂 | 逐步完善参数类型支持 |

---

## 参考资料

### 官方文档

- [Apple - Hosting Audio Unit Extensions](https://developer.apple.com/documentation/audiotoolbox/audio_unit_v3_plug-ins/hosting_audio_unit_extensions_using_the_auv2_api)
- [Apple - AudioUnit API Documentation](https://developer.apple.com/documentation/audiotoolbox/audiounit)
- [VST 3 SDK Documentation](https://steinbergmedia.github.io/vst3_doc/vstsdk/index.html)
- [VST 3 SDK GitHub](https://github.com/steinbergmedia/vst3sdk)
- [Electron - Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [MDN - AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)

### 开源项目

- [vst-js](https://github.com/ramirezd42/vst-js) - VST3 native addon（实验性）
- [node-audio](https://github.com/ramirezd42/node-audio) - JUCE + Node.js（实验性）
- [JUCE Framework](https://github.com/juce-framework/JUCE) - 业界标准音频框架
- [JUCE AudioPluginHost Example](https://github.com/juce-framework/JUCE/tree/master/extras/AudioPluginHost)

### 技术博客与教程

- [How to do realtime recording with effect processing on iOS](http://teragonaudio.com/article/How-to-do-realtime-recording-with-effect-processing-on-iOS.html)
- [Web Audio API Part 2: Moving to Electron](https://blog.scottlogic.com/2016/07/05/audio-api-electron.html)
- [JUCE - Cascading plug-in effects](https://docs.juce.com/master/tutorial_audio_processor_graph.html)
- [An iOS tone generator (introduction to AudioUnits)](https://www.cocoawithlove.com/2010/10/ios-tone-generator-introduction-to.html)

### 相关 Issues

- [Electron #11479 - Buffer performance issue in native addon](https://github.com/electron/electron/issues/11479)
- [node-audio #9 - Hosting AudioUnit with PluginNode](https://github.com/ramirezd42/node-audio/issues/9)
- [vst-js #8 - Multi-platform support](https://github.com/ramirezd42/vst-js/issues/8)

---

## 总结

**推荐方案**: 优先实现 **AudioUnit 原生加载**（方案 4），使用直接 API 调用（方案 1），预计 **1-2 周** 完成基础功能。VST3 支持可作为 Phase 2，根据用户需求选择直接实现或引入 JUCE。

**核心优势**:
- 快速上线，满足 macOS 用户主流需求
- 技术风险可控，无第三方许可证问题
- 架构清晰，便于后续扩展

**下一步行动**:
1. 完善 `native/src/plugin_host.cpp` 的 AudioUnit 加载逻辑
2. 实现音频线程桥接（AudioWorklet ↔ Native）
3. 前端 UI 集成与测试

---

*调研完成时间: 2026-02-16*
*研究员: researcher*
