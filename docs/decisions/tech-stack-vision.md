# FieldCorder 技术栈与产品方向

*记录于 2026-03-17*

---

## 产品定位

**AI prompt 驱动的音频编辑工具**

用户描述意图 → AI 操作工具 → 结果呈现在时间线上

示例：
- "清理第3场戏的对白" → AI 调用降噪、LUFS 分析、动态处理
- "这段采访室内混响太重，修好后导出广播标准" → AI 串联 de-reverb + limiting + 导出

---

## 技术栈决策

### 音频引擎

| 层级 | 技术 | 状态 |
|------|------|------|
| 播放/预览 | Web Audio API | ✅ 现在用 |
| 文件解码/编码 | Rust (Tauri 后端) | ✅ 现在用 |
| DSP 处理模块 | Rust → WASM | 🔮 规划中 |

**关键决策：** 现阶段保持 Web Audio API，但将所有音频调用收敛到 `AudioEngine` 抽象层，未来换底层不动上层。

### WASM 策略

Rust 写处理逻辑，编译两个目标：
- `tauri` → 桌面版（native 速度）
- `wasm32` → Web 版（浏览器可跑）

同一套核心代码，两个平台共用。类比：Photopea、Figma 的做法。

### 插件链

**不做 VST/AU**，而是内置 WASM 处理模块，暴露可编程 API 供 AI 调用：

```
denoise(trackId, region, strength)
normalize(trackId, target_lufs)
deReverb(trackId, region, amount)
spectralRepair(trackId, region)
```

### AI 集成方向（待定）

- **方案 A：本地 AI** — 隐私好，离线可用
- **方案 B：云端 API（Claude 等）** — 能力强，需联网
- **方案 C：MCP Server** — FieldCorder 暴露工具集，任何 AI 模型可调用

---

## Web 版可行性

技术上可行：前端已是 web 技术，Rust core 编译为 WASM 后可静态托管（类 Photopea 模式）。

**当前阶段不做**，待桌面版功能稳定后评估。

---

## 暂缓的功能

以下需要原生音频引擎（CoreAudio/ASIO），目前不在路线图：
- 实时低延迟监听（< 5ms）
- 录音功能
- VST/AU 宿主
